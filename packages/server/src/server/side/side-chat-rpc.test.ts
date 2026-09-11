import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { AgentManager } from "../agent/agent-manager.js";
import type {
  AgentCapabilityFlags,
  AgentClient,
  AgentCreateSessionOptions,
  AgentLaunchContext,
  AgentPersistenceHandle,
  AgentPromptInput,
  AgentProvider,
  AgentRunResult,
  AgentSession,
  AgentSessionConfig,
  AgentStreamEvent,
} from "../agent/agent-sdk-types.js";
import { AgentStorage } from "../agent/agent-storage.js";
import { ensureUnarchivedAgentLoaded } from "../agent/agent-loading.js";
import { createPaseoToolCatalog } from "../agent/tools/paseo-tools.js";
import type { ProviderSnapshotManager } from "../agent/provider-snapshot-manager.js";
import { SIDE_MAIN_AGENT_ID_LABEL } from "./provider-enforcement.js";
import { SideChatError, SideChatService } from "./side-chat-service.js";
import { SideChatStore } from "./side-chat-store.js";

const TEST_CAPABILITIES = {
  supportsStreaming: true,
  supportsSessionPersistence: true,
  supportsSessionListing: true,
  supportsDynamicModes: false,
  supportsMcpServers: false,
  supportsReasoningStream: false,
  supportsToolInvocations: true,
} as const;

class TestAgentSession implements AgentSession {
  readonly provider: AgentProvider;
  capabilities: AgentCapabilityFlags = { ...TEST_CAPABILITIES };
  readonly id = randomUUID();
  private readonly subscribers = new Set<(event: AgentStreamEvent) => void>();
  private turnIdCounter = 0;
  private currentTurnId: string | null = null;
  readonly startPrompts: AgentPromptInput[] = [];
  turnScript?: (
    turnId: string,
    pushEvent: (event: AgentStreamEvent) => void,
    prompt: AgentPromptInput,
  ) => void | Promise<void>;
  interruptSignal?: () => void;

  constructor(private readonly config: AgentSessionConfig) {
    this.provider = config.provider ?? "claude";
  }

  async run(): Promise<AgentRunResult> {
    return {
      sessionId: this.id,
      finalText: "",
      timeline: [],
    };
  }

  async startTurn(prompt: AgentPromptInput): Promise<{ turnId: string }> {
    const turnId = `turn-${++this.turnIdCounter}`;
    this.currentTurnId = turnId;
    this.startPrompts.push(prompt);

    queueMicrotask(async () => {
      this.pushEvent({ type: "turn_started", provider: this.provider, turnId });
      if (this.turnScript) {
        await this.turnScript(turnId, (event) => this.pushEvent(event), prompt);
      } else {
        this.pushEvent({
          type: "timeline",
          provider: this.provider,
          turnId,
          item: {
            type: "assistant_message",
            text: "Side assistant reply",
          },
        });
        this.pushEvent({ type: "turn_completed", provider: this.provider, turnId });
      }
    });

    return { turnId };
  }

  subscribe(callback: (event: AgentStreamEvent) => void): () => void {
    this.subscribers.add(callback);
    return () => {
      this.subscribers.delete(callback);
    };
  }

  pushEvent(event: AgentStreamEvent): void {
    for (const cb of this.subscribers) {
      try {
        cb(event);
      } catch {
        // test subscriber isolation
      }
    }
  }

  async interrupt(): Promise<void> {
    if (this.currentTurnId) {
      this.pushEvent({
        type: "turn_canceled",
        provider: this.provider,
        turnId: this.currentTurnId,
      });
    }
    this.interruptSignal?.();
  }

  async *streamHistory(): AsyncGenerator<AgentStreamEvent> {}

  async getRuntimeInfo() {
    return {
      provider: this.provider,
      sessionId: this.id,
      model: this.config.model ?? null,
      modeId: this.config.modeId ?? null,
    };
  }

  async getAvailableModes() {
    return [];
  }

  async getCurrentMode() {
    return null;
  }

  async setMode(): Promise<void> {}
  getPendingPermissions() {
    return [];
  }
  async respondToPermission(): Promise<void> {}

  describePersistence() {
    return {
      provider: this.provider,
      sessionId: this.id,
      nativeHandle: this.id,
    };
  }

  async close(): Promise<void> {}
}
class TestAgentClient implements AgentClient {
  readonly capabilities: AgentCapabilityFlags;
  readonly createdConfigs: AgentSessionConfig[] = [];
  readonly createdOptions: (AgentCreateSessionOptions | undefined)[] = [];
  readonly launchContexts: (AgentLaunchContext | undefined)[] = [];
  readonly sessions: TestAgentSession[] = [];
  sessionFactory?: (config: AgentSessionConfig) => TestAgentSession;

  constructor(
    readonly provider: AgentProvider = "claude",
    capabilities: AgentCapabilityFlags = TEST_CAPABILITIES,
  ) {
    this.capabilities = capabilities;
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async createSession(
    config: AgentSessionConfig,
    launchContext?: AgentLaunchContext,
    options?: AgentCreateSessionOptions,
  ): Promise<AgentSession> {
    this.createdConfigs.push(config);
    this.createdOptions.push(options);
    this.launchContexts.push(launchContext);
    const session = this.sessionFactory
      ? this.sessionFactory(config)
      : new TestAgentSession(config);
    this.sessions.push(session);
    return session;
  }

  async resumeSession(
    _handle: AgentPersistenceHandle,
    config?: Partial<AgentSessionConfig>,
  ): Promise<AgentSession> {
    const fullConfig: AgentSessionConfig = {
      provider: this.provider,
      cwd: config?.cwd ?? process.cwd(),
      daemonAppendSystemPrompt: config?.daemonAppendSystemPrompt,
    };
    const session = this.sessionFactory
      ? this.sessionFactory(fullConfig)
      : new TestAgentSession(fullConfig);
    this.sessions.push(session);
    return session;
  }
}

describe("SideChatService lifecycle and behavioral integration", () => {
  let tmpDir: string;
  let logger: pino.Logger;
  let storage: AgentStorage;
  let store: SideChatStore;
  let claudeClient: TestAgentClient;
  let codexClient: TestAgentClient;
  let customUnsupportedClient: TestAgentClient;
  let manager: AgentManager;
  let service: SideChatService;
  let mainAgentId: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "side-chat-test-"));
    logger = pino({ level: "silent" });
    storage = new AgentStorage(path.join(tmpDir, "agents"), logger);
    store = new SideChatStore(tmpDir, logger);

    claudeClient = new TestAgentClient("claude", {
      ...TEST_CAPABILITIES,
      supportsNativePaseoTools: true,
    });
    codexClient = new TestAgentClient("codex");
    customUnsupportedClient = new TestAgentClient("custom-unsupported");

    manager = new AgentManager({
      clients: {
        claude: claudeClient,
        codex: codexClient,
        "custom-unsupported": customUnsupportedClient,
      },
      registry: storage,
      logger,
      mcpBaseUrl: "http://127.0.0.1:6767/mcp/agents",
      paseoToolCatalogFactory: async (context) =>
        createPaseoToolCatalog({
          agentManager: manager,
          agentStorage: storage,
          providerSnapshotManager: {} as ProviderSnapshotManager,
          paseoToolPolicy: context.paseoToolPolicy,
          callerAgentId: context.callerAgentId,
          logger,
        }),
    });

    service = new SideChatService(manager, store, logger, undefined, async () => ({
      modeId: "bypassPermissions",
    }));

    const mainAgent = await manager.createAgent(
      { provider: "claude", cwd: tmpDir, model: "claude-3-7-sonnet" },
      undefined,
      { workspaceId: "ws-1", initialTitle: "Main Agent" },
    );
    mainAgentId = mainAgent.id;
  });

  afterEach(async () => {
    await manager.flushForShutdown();
    await storage.flush();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test("get returns initial snapshot with supportedProviders when no chat exists", async () => {
    const snapshot = await service.get(mainAgentId);
    expect(snapshot).toMatchObject({
      mainAgentId,
      sideAgentId: null,
      status: "idle",
      error: null,
      messages: [],
      steeringProposal: null,
      provider: "claude",
      model: "claude-3-7-sonnet",
    });
    expect(snapshot.supportedProviders).toContain("claude");
    expect(snapshot.supportedProviders).toContain("codex");
    expect(snapshot.supportedProviders).not.toContain("custom-unsupported");
  });

  test("get on unsupported main provider returns provider null and supportedProviders list for UI picker", async () => {
    const unsupportedMain = await manager.createAgent(
      { provider: "custom-unsupported", cwd: tmpDir, model: "unsupported-model" },
      undefined,
      { workspaceId: "ws-2", initialTitle: "Unsupported Main" },
    );

    const snapshot = await service.get(unsupportedMain.id);
    expect(snapshot.provider).toBeNull();
    expect(snapshot.model).toBeNull();
    expect(snapshot.supportedProviders).toContain("claude");
    expect(snapshot.supportedProviders).toContain("codex");
    expect(snapshot.supportedProviders).not.toContain("custom-unsupported");
  });

  test("first turn with streaming chunk assembly, tool-enabled config, and steer proposal extraction", async () => {
    claudeClient.sessionFactory = (config) => {
      const session = new TestAgentSession(config);
      session.turnScript = async (turnId, pushEvent) => {
        pushEvent({
          type: "timeline",
          provider: session.provider,
          turnId,
          item: {
            type: "assistant_message",
            text: "I inspected the server configuration. ",
          },
        });
        pushEvent({
          type: "timeline",
          provider: session.provider,
          turnId,
          item: {
            type: "assistant_message",
            text: "It listens on port 3000.\n<steer_proposal>Change port to 8080</steer_proposal>",
          },
        });
        pushEvent({ type: "turn_completed", provider: session.provider, turnId });
      };
      return session;
    };

    const snapshot = await service.send(mainAgentId, "How is the server configured?", {
      wait: true,
    });

    expect(snapshot.status).toBe("idle");
    expect(snapshot.messages).toHaveLength(2);
    expect(snapshot.messages[0]).toMatchObject({
      role: "user",
      text: "How is the server configured?",
    });
    expect(snapshot.messages[1].role).toBe("assistant");
    expect(snapshot.messages[1].text).toBe(
      "I inspected the server configuration. It listens on port 3000.",
    );
    expect(snapshot.steeringProposal).toBe("Change port to 8080");

    const sideAgentId = snapshot.sideAgentId;
    expect(sideAgentId).toBeDefined();
    const sideAgent = manager.getAgent(sideAgentId!);
    expect(sideAgent).not.toBeNull();
    expect(sideAgent?.internal).toBe(true);
    expect(sideAgent?.config.readOnly).toBe(true);
    expect(sideAgent?.config.durableInternal).toBe(true);
    expect(sideAgent?.config.modeId).toBe("bypassPermissions");
    expect(sideAgent?.config.paseoToolPolicy?.enabledTools).toContain("get_agent_status");
    expect(sideAgent?.config.paseoToolPolicy?.enabledTools).not.toContain("send_agent_prompt");
    expect(sideAgent?.labels[SIDE_MAIN_AGENT_ID_LABEL]).toBe(mainAgentId);

    // Runtime delivery: the native-capable client receives the filtered
    // catalog — read-only daemon tools present, mutating tools absent.
    const sideLaunchContext = claudeClient.launchContexts.at(-1);
    const sideTools = sideLaunchContext?.paseoTools;
    expect(sideTools?.getTool("get_agent_status")).toBeDefined();
    expect(sideTools?.getTool("list_agents")).toBeDefined();
    expect(sideTools?.getTool("send_agent_prompt")).toBeUndefined();
    expect(sideTools?.getTool("create_terminal")).toBeUndefined();
    // Native delivery strips the internal MCP server from the launch config.
    expect(claudeClient.createdConfigs.at(-1)?.mcpServers?.paseo).toBeUndefined();
  });

  test("MCP-only side provider receives the daemon MCP endpoint instead of native tools", async () => {
    const codexMain = await manager.createAgent(
      { provider: "codex", cwd: tmpDir, model: "codex-model" },
      undefined,
      { workspaceId: "ws-codex", initialTitle: "Codex Main" },
    );

    const snapshot = await service.send(codexMain.id, "status?", { wait: true });
    expect(snapshot.status).toBe("idle");

    const sideConfig = codexClient.createdConfigs.at(-1);
    expect(sideConfig?.readOnly).toBe(true);
    expect(sideConfig?.mcpServers?.paseo).toMatchObject({
      type: "http",
      url: expect.stringContaining("/mcp/agents?callerAgentId="),
    });
    expect(codexClient.launchContexts.at(-1)?.paseoTools).toBeUndefined();
  });

  test("second turn sends only new rows and main agent timeline remains untouched", async () => {
    let sideSession: TestAgentSession | null = null;
    claudeClient.sessionFactory = (config) => {
      const session = new TestAgentSession(config);
      sideSession = session;
      return session;
    };

    await manager.appendTimelineItem(mainAgentId, {
      type: "user_message",
      text: "Create a web server",
    });
    await manager.appendTimelineItem(mainAgentId, {
      type: "assistant_message",
      text: "Server created on port 3000",
    });

    const mainTimelineBefore = manager.fetchTimeline(mainAgentId).rows;
    expect(mainTimelineBefore).toHaveLength(2);

    const snapshot1 = await service.send(mainAgentId, "Explain what you created", { wait: true });
    expect(snapshot1.messages).toHaveLength(2);
    expect(sideSession).not.toBeNull();
    const promptTurn1 = sideSession!.startPrompts[0] as string;
    expect(promptTurn1).toContain("main-session-context");
    expect(promptTurn1).toContain("Create a web server");
    expect(promptTurn1).toContain("Explain what you created");

    // Main agent timeline is not modified by side chat execution
    const mainTimelineAfterTurn1 = manager.fetchTimeline(mainAgentId).rows;
    expect(mainTimelineAfterTurn1).toEqual(mainTimelineBefore);

    // Turn 2 with no main timeline change: only prefixed user request is sent
    const snapshot2 = await service.send(mainAgentId, "Does it support SSL?", { wait: true });
    expect(snapshot2.messages).toHaveLength(4);
    const promptTurn2 = sideSession!.startPrompts[1] as string;
    expect(promptTurn2).toContain(`"mainAgentId":"${mainAgentId}"`);
    expect(promptTurn2).toContain("Does it support SSL?");

    expect(manager.fetchTimeline(mainAgentId).rows).toEqual(mainTimelineBefore);

    // Append new item to main agent timeline
    await manager.appendTimelineItem(mainAgentId, {
      type: "user_message",
      text: "Add HTTPS support",
    });
    expect(manager.fetchTimeline(mainAgentId).rows).toHaveLength(3);

    // Turn 3: delta update containing only new items
    const snapshot3 = await service.send(mainAgentId, "Did you see HTTPS?", { wait: true });
    expect(snapshot3.messages).toHaveLength(6);
    const promptTurn3 = sideSession!.startPrompts[2] as string;
    expect(promptTurn3).toContain("main-session-updates");
    expect(promptTurn3).toContain("Add HTTPS support");
    const contextObj = JSON.parse(promptTurn3.split("\n\n")[1]) as {
      kind: string;
      originalRequest?: string;
    };
    expect(contextObj.kind).toBe("main-session-updates");
    expect(contextObj.originalRequest).toBeUndefined();

    // Main timeline remains strictly isolated
    expect(manager.fetchTimeline(mainAgentId).rows).toHaveLength(3);
  });

  test("concurrency blocked: concurrent send throws busy error before awaiting", async () => {
    let releaseTurn!: () => void;
    const holdTurn = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });

    claudeClient.sessionFactory = (config) => {
      const session = new TestAgentSession(config);
      session.turnScript = async (turnId, pushEvent) => {
        await holdTurn;
        pushEvent({
          type: "timeline",
          provider: session.provider,
          turnId,
          item: { type: "assistant_message", text: "Finished" },
        });
        pushEvent({ type: "turn_completed", provider: session.provider, turnId });
      };
      return session;
    };

    const runningSnapshot = await service.send(mainAgentId, "First message");
    expect(runningSnapshot.status).toBe("running");

    // Synchronous rejection on concurrent send
    await expect(service.send(mainAgentId, "Second message")).rejects.toThrowError(SideChatError);
    try {
      await service.send(mainAgentId, "Second message");
    } catch (err) {
      expect(err).toBeInstanceOf(SideChatError);
      const sideErr = err as SideChatError;
      expect(sideErr.code).toBe("busy");
      expect(sideErr.message).toBe(
        "Side is already responding. Stop it before sending another message.",
      );
    }

    releaseTurn();
    const finalSnapshot = await service.stop(mainAgentId);
    expect(finalSnapshot.status).toBe("idle");
    expect(finalSnapshot.messages).toHaveLength(2);
  });

  test("cancellation: stop cancels active run and sets status to idle", async () => {
    let cancelReceived = false;
    let finishSession!: () => void;
    const sessionWait = new Promise<void>((resolve) => {
      finishSession = resolve;
    });

    claudeClient.sessionFactory = (config) => {
      const session = new TestAgentSession(config);
      session.turnScript = async () => {
        await sessionWait;
      };
      session.interruptSignal = () => {
        cancelReceived = true;
        finishSession();
      };
      return session;
    };

    const runningSnapshot = await service.send(mainAgentId, "Long task");
    expect(runningSnapshot.status).toBe("running");

    const stopSnapshot = await service.stop(mainAgentId);
    expect(cancelReceived).toBe(true);
    expect(stopSnapshot.status).toBe("idle");

    const getSnapshot = await service.get(mainAgentId);
    expect(getSnapshot.status).toBe("idle");
  });

  test("failure visibility: turn failure is recorded and surfaced in snapshot", async () => {
    claudeClient.sessionFactory = (config) => {
      const session = new TestAgentSession(config);
      session.turnScript = async (turnId, pushEvent) => {
        pushEvent({
          type: "turn_failed",
          provider: session.provider,
          turnId,
          error: "Model rate limit exceeded",
        });
      };
      return session;
    };

    const snapshot = await service.send(mainAgentId, "Hello", { wait: true });
    expect(snapshot.status).toBe("error");
    expect(snapshot.error).toBe("Model rate limit exceeded");

    const getSnapshot = await service.get(mainAgentId);
    expect(getSnapshot.status).toBe("error");
    expect(getSnapshot.error).toBe("Model rate limit exceeded");
  });

  test("store reload persistence: side chat history and checkpoint survive restart", async () => {
    await service.send(mainAgentId, "Turn 1 question", { wait: true });
    const snapshot2 = await service.send(mainAgentId, "Turn 2 question", { wait: true });
    expect(snapshot2.messages).toHaveLength(4);

    const reloadedStore = new SideChatStore(tmpDir, logger);
    const reloadedService = new SideChatService(manager, reloadedStore, logger);

    const reloadedSnapshot = await reloadedService.get(mainAgentId);
    expect(reloadedSnapshot.mainAgentId).toBe(mainAgentId);
    expect(reloadedSnapshot.sideAgentId).toBe(snapshot2.sideAgentId);
    expect(reloadedSnapshot.status).toBe("idle");
    expect(reloadedSnapshot.provider).toBe("claude");
    expect(reloadedSnapshot.model).toBe(snapshot2.model);
    expect(reloadedSnapshot.messages).toHaveLength(4);
    expect(reloadedSnapshot.messages[0].text).toBe("Turn 1 question");
    expect(reloadedSnapshot.messages[2].text).toBe("Turn 2 question");

    const snapshot3 = await reloadedService.send(mainAgentId, "Turn 3 question", { wait: true });
    expect(snapshot3.messages).toHaveLength(6);
  });

  test("stale sideAgentId from a missing stored record self-heals into a fresh side", async () => {
    // Give the main agent real timeline content so the recreated side's first
    // prompt must carry the full context envelope.
    await manager.appendTimelineItem(mainAgentId, {
      type: "user_message",
      text: "Build the status widget",
    });
    await manager.appendTimelineItem(mainAgentId, {
      type: "assistant_message",
      text: "Working on the status widget now.",
    });

    const first = await service.send(mainAgentId, "First question", { wait: true });
    const staleSideId = first.sideAgentId;
    expect(staleSideId).toBeDefined();

    // Simulate a daemon restart where the side agent record is gone but the
    // side-chat record still references it. Records live under
    // agents/<project-dir>/<id>.json, and a fresh AgentStorage is required
    // because the original instance caches records in memory.
    await manager.archiveAgent(staleSideId!);
    const agentsDir = path.join(tmpDir, "agents");
    for (const entry of await fs.readdir(agentsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      await fs.rm(path.join(agentsDir, entry.name, `${staleSideId}.json`), { force: true });
    }
    const freshStorage = new AgentStorage(agentsDir, logger);
    // Prove the record is truly gone so the loader hits "Agent not found",
    // not the "Agent is archived" branch.
    expect(await freshStorage.get(staleSideId!)).toBeNull();

    const reloadedStore = new SideChatStore(tmpDir, logger);
    const reloadedService = new SideChatService(manager, reloadedStore, logger, async (agentId) =>
      ensureUnarchivedAgentLoaded(agentId, {
        agentManager: manager,
        agentStorage: freshStorage,
        logger,
      }),
    );

    const snapshot = await reloadedService.send(mainAgentId, "Are you still there?", {
      wait: true,
    });
    expect(snapshot.status).toBe("idle");
    expect(snapshot.sideAgentId).not.toBe(staleSideId);
    expect(snapshot.sideAgentId).toBeDefined();
    // Prior messages survive; the fresh side gets them as continuity context.
    expect(snapshot.messages.length).toBeGreaterThanOrEqual(4);

    // The recreated side must receive the full main-session context (not a
    // delta against the stale checkpoint), including the trusted mainAgentId.
    const newSideSession = claudeClient.sessions.at(-1)!;
    const promptInput = newSideSession.startPrompts.at(-1)!;
    const promptText =
      typeof promptInput === "string"
        ? promptInput
        : promptInput
            .filter((block) => block.type === "text")
            .map((block) => block.text)
            .join("\n");
    expect(promptText).toContain("main-session-context");
    expect(promptText).toContain(mainAgentId);
    expect(promptText).toContain("Working on the status widget now.");
    expect(promptText).toContain("Earlier Side conversation for continuity:");
  });

  test("supports explicit native provider selection on first turn for unsupported main provider and locks it", async () => {
    const unsupportedMain = await manager.createAgent(
      { provider: "custom-unsupported", cwd: tmpDir, model: "custom-model" },
      undefined,
      { workspaceId: "ws-unsupported", initialTitle: "Unsupported Main" },
    );

    const initial = await service.get(unsupportedMain.id);
    expect(initial.provider).toBeNull();
    expect(initial.model).toBeNull();
    expect(initial.supportedProviders).toContain("claude");
    expect(initial.supportedProviders).not.toContain("custom-unsupported");

    await expect(service.send(unsupportedMain.id, "Hello")).rejects.toThrowError(SideChatError);
    try {
      await service.send(unsupportedMain.id, "Hello");
    } catch (err) {
      expect((err as SideChatError).code).toBe("provider_unavailable");
    }

    const snapshot1 = await service.send(unsupportedMain.id, "Hello with Claude", {
      provider: "claude",
      wait: true,
    });
    expect(snapshot1.provider).toBe("claude");
    expect(snapshot1.status).toBe("idle");

    await expect(
      service.send(unsupportedMain.id, "Switch to codex", { provider: "codex" }),
    ).rejects.toThrowError(SideChatError);
    try {
      await service.send(unsupportedMain.id, "Switch to codex", { provider: "codex" });
    } catch (err) {
      expect((err as SideChatError).code).toBe("provider_locked");
    }
  });

  test("recovers stale running status to error after ungraceful daemon exit", async () => {
    const record = {
      mainAgentId,
      sideAgentId: "side-stale",
      status: "running" as const,
      error: null,
      messages: [{ id: "m1", role: "user" as const, text: "Unfinished message" }],
      steeringProposal: null,
      checkpoint: null,
      provider: "claude",
      model: "claude-3-7-sonnet",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await store.save(record);

    const freshStore = new SideChatStore(tmpDir, logger);
    const freshService = new SideChatService(manager, freshStore, logger);

    const snapshot = await freshService.get(mainAgentId);
    expect(snapshot.status).toBe("error");
    expect(snapshot.error).toBe(
      "Side was interrupted when the host stopped. Send a message to continue.",
    );
  });

  test("completes turns with many tool calls now that budgets are removed", async () => {
    claudeClient.sessionFactory = (config) => {
      const session = new TestAgentSession(config);
      session.turnScript = async (turnId, pushEvent) => {
        for (let i = 1; i <= 26; i++) {
          pushEvent({
            type: "timeline",
            provider: session.provider,
            turnId,
            item: {
              type: "tool_call",
              callId: `tool-${i}`,
              name: "read",
              status: "completed",
              detail: { type: "unknown", input: {}, output: null },
            },
          });
        }
        pushEvent({
          type: "timeline",
          provider: session.provider,
          turnId,
          item: {
            type: "assistant_message",
            text: "Inspected files",
          },
        });
        pushEvent({ type: "turn_completed", provider: session.provider, turnId });
      };
      return session;
    };

    const snapshot = await service.send(mainAgentId, "Inspect everything", { wait: true });
    expect(snapshot.status).toBe("idle");
    expect(snapshot.messages.at(-1)?.text).toBe("Inspected files");
  });

  test("forks the side session from the main native session when supported", async () => {
    // getAgent returns a shallow copy; the session object is shared, so set the
    // capability there — the manager reads capabilities off the live session.
    const mainSession = manager.getAgent(mainAgentId)?.session as
      | TestAgentSession
      | null
      | undefined;
    if (mainSession) {
      mainSession.capabilities.supportsSessionFork = true;
    }

    const snapshot = await service.send(mainAgentId, "What is the goal?", { wait: true });
    expect(snapshot.status).toBe("idle");

    const sideConfig = claudeClient.createdConfigs.at(-1);
    const sideOptions = claudeClient.createdOptions.at(-1);
    expect(sideConfig?.readOnly).toBe(true);
    // Forked side inherits the main system prompt instead of the digest prompt.
    expect(sideConfig?.systemPrompt).toBe(
      manager.getAgent(mainAgentId)?.config.systemPrompt ?? undefined,
    );
    expect(sideOptions?.forkFrom?.sessionId).toBe(mainSession?.id);

    const sideSession = claudeClient.sessions.at(-1);
    const firstPrompt = String(sideSession?.startPrompts[0] ?? "");
    expect(firstPrompt).toContain("forked from this development session");
    expect(firstPrompt).toContain("What is the goal?");
    expect(firstPrompt).not.toContain("main-session-context");
    expect(firstPrompt).toContain(`"mainAgentId":"${mainAgentId}"`);
  });

  test("reuses a fresh forked side session and re-forks after the reuse window", async () => {
    const mainSession = manager.getAgent(mainAgentId)?.session as
      | TestAgentSession
      | null
      | undefined;
    if (mainSession) {
      mainSession.capabilities.supportsSessionFork = true;
    }

    await service.send(mainAgentId, "First question", { wait: true });
    const firstSideId = claudeClient.sessions.at(-1)?.id;

    // Chained follow-up within the reuse window: same side session, delta prompt.
    await service.send(mainAgentId, "Follow up", { wait: true });
    expect(claudeClient.sessions.at(-1)?.id).toBe(firstSideId);
    const followUpPrompt = String(claudeClient.sessions.at(-1)?.startPrompts.at(-1) ?? "");
    expect(followUpPrompt).toContain("Follow up");

    // Past the reuse window: a fresh fork is created and the stale one archived.
    const staleService = new SideChatService(manager, store, logger, undefined, undefined, 0);
    await staleService.send(mainAgentId, "Much later question", { wait: true });
    const newSideId = claudeClient.sessions.at(-1)?.id;
    expect(newSideId).not.toBe(firstSideId);
    const newPrompt = String(claudeClient.sessions.at(-1)?.startPrompts.at(-1) ?? "");
    expect(newPrompt).toContain("forked from this development session");
  });

  test("upgrades a legacy digest side to a fork on the next message", async () => {
    await service.send(mainAgentId, "Legacy question", { wait: true });
    const legacySideId = claudeClient.sessions.at(-1)?.id;

    const mainSession = manager.getAgent(mainAgentId)?.session as
      | TestAgentSession
      | null
      | undefined;
    if (mainSession) {
      mainSession.capabilities.supportsSessionFork = true;
    }

    await service.send(mainAgentId, "Now with fork support", { wait: true });
    const newSideId = claudeClient.sessions.at(-1)?.id;
    expect(newSideId).not.toBe(legacySideId);
    expect(claudeClient.createdOptions.at(-1)?.forkFrom?.sessionId).toBe(mainSession?.id);
    const prompt = String(claudeClient.sessions.at(-1)?.startPrompts.at(-1) ?? "");
    expect(prompt).toContain("forked from this development session");
  });

  test("does not fork when the side provider differs from the main provider", async () => {
    const mainSession = manager.getAgent(mainAgentId)?.session as
      | TestAgentSession
      | null
      | undefined;
    if (mainSession) {
      mainSession.capabilities.supportsSessionFork = true;
    }

    const snapshot = await service.send(mainAgentId, "Cross-provider question", {
      wait: true,
      provider: "codex",
    });
    expect(snapshot.status).toBe("idle");
    expect(codexClient.createdOptions.at(-1)?.forkFrom).toBeUndefined();
    // A foreign provider must not inherit the main model id.
    expect(codexClient.createdConfigs.at(-1)?.model).not.toBe("claude-3-7-sonnet");
  });

  test("validates user prompt length and rejects empty prompts", async () => {
    await expect(service.send(mainAgentId, "   ")).rejects.toThrowError(SideChatError);
    try {
      await service.send(mainAgentId, "   ");
    } catch (err) {
      expect((err as SideChatError).code).toBe("invalid_prompt");
    }

    const overLength = "a".repeat(32_001);
    await expect(service.send(mainAgentId, overLength)).rejects.toThrowError(SideChatError);
    try {
      await service.send(mainAgentId, overLength);
    } catch (err) {
      expect((err as SideChatError).code).toBe("invalid_prompt");
    }
  });

  test("get throws for non-existent or internal agent", async () => {
    await expect(service.get("non-existent-agent-id")).rejects.toThrowError(SideChatError);
    try {
      await service.get("non-existent-agent-id");
    } catch (err) {
      expect((err as SideChatError).code).toBe("agent_missing");
    }

    const internalAgent = await manager.createAgent(
      { provider: "claude", cwd: tmpDir, internal: true },
      undefined,
      { workspaceId: "ws-internal", initialTitle: "Internal Agent" },
    );
    await expect(service.get(internalAgent.id)).rejects.toThrowError(SideChatError);
    try {
      await service.get(internalAgent.id);
    } catch (err) {
      expect((err as SideChatError).code).toBe("invalid_parent");
    }
  });
});
