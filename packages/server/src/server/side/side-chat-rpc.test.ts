import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { AgentManager } from "../agent/agent-manager.js";
import type {
  AgentClient,
  AgentPersistenceHandle,
  AgentPromptInput,
  AgentProvider,
  AgentRunResult,
  AgentSession,
  AgentSessionConfig,
  AgentStreamEvent,
} from "../agent/agent-sdk-types.js";
import { AgentStorage } from "../agent/agent-storage.js";
import { SIDE_READ_ONLY_LABEL } from "./provider-enforcement.js";
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
  readonly capabilities = TEST_CAPABILITIES;
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
    };
  }

  async close(): Promise<void> {}
}

class TestAgentClient implements AgentClient {
  readonly capabilities = TEST_CAPABILITIES;
  readonly createdConfigs: AgentSessionConfig[] = [];
  readonly sessions: TestAgentSession[] = [];
  sessionFactory?: (config: AgentSessionConfig) => TestAgentSession;

  constructor(readonly provider: AgentProvider = "claude") {}

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async createSession(config: AgentSessionConfig): Promise<AgentSession> {
    this.createdConfigs.push(config);
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

    claudeClient = new TestAgentClient("claude");
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
    });

    service = new SideChatService(manager, store, logger);

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

  test("first turn with streaming chunk assembly, read-only config, and steer proposal extraction", async () => {
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
    expect(sideAgent?.labels[SIDE_READ_ONLY_LABEL]).toBe("true");
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
    expect(promptTurn2).toBe("Side user request:\n\nDoes it support SSL?");

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

  test("stops and marks error when inspection budget is exceeded", async () => {
    claudeClient.sessionFactory = (config) => {
      const session = new TestAgentSession(config);
      session.turnScript = async (turnId, pushEvent) => {
        for (let i = 1; i <= 10; i++) {
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
    expect(snapshot.status).toBe("error");
    expect(snapshot.error).toContain("Side reached its inspection/output limit");
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
