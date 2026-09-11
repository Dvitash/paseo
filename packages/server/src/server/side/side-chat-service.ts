import { randomUUID } from "node:crypto";
import { setTimeout, clearTimeout } from "node:timers";
import type { Logger } from "pino";
import type { AgentManager, ManagedAgent } from "../agent/agent-manager.js";
import type { AgentStorage } from "../agent/agent-storage.js";
import { ensureUnarchivedAgentLoaded } from "../agent/agent-loading.js";
import { prepareSidePrompt } from "./context-curator.js";
import {
  SUPPORTED_SIDE_PROVIDERS,
  SIDE_MAIN_AGENT_ID_LABEL,
  buildSideProviderConfig,
  verifySideIntegrity,
} from "./provider-enforcement.js";
import { SideChatStore } from "./side-chat-store.js";
import type { SideChatSnapshot, StoredSideChatRecord } from "./types.js";
import type { SideChatSendOptions } from "@getpaseo/protocol/side";

export interface SendSideChatOptions extends SideChatSendOptions {
  wait?: boolean;
}

export class SideChatError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "SideChatError";
  }
}

interface ActiveSideTurn {
  record: StoredSideChatRecord;
  done: Promise<void>;
  limitError: string | null;
}

const services = new WeakMap<AgentManager, SideChatService>();

export function getSideChatService(
  manager: AgentManager,
  storage: AgentStorage,
  paseoHome: string,
  logger: Logger,
  resolveCreateConfig?: SideCreateConfigResolver,
): SideChatService {
  let service = services.get(manager);
  if (!service) {
    service = new SideChatService(
      manager,
      new SideChatStore(paseoHome),
      logger,
      (agentId) =>
        ensureUnarchivedAgentLoaded(agentId, {
          agentManager: manager,
          agentStorage: storage,
          logger,
        }),
      resolveCreateConfig,
    );
    services.set(manager, service);
  }
  return service;
}

export type SideCreateConfigResolver = (input: {
  cwd: string;
  provider: string;
}) => Promise<{ modeId?: string; featureValues?: Record<string, unknown> }>;

export class SideChatService {
  private readonly busy = new Set<string>();
  private readonly turns = new Map<string, ActiveSideTurn>();
  private providers: { expiresAt: number; promise: Promise<string[]> } | null = null;

  constructor(
    private readonly agentManager: AgentManager,
    private readonly store: SideChatStore,
    private readonly logger?: Logger,
    private readonly loadAgent?: (agentId: string) => Promise<ManagedAgent>,
    private readonly resolveCreateConfig?: SideCreateConfigResolver,
  ) {}

  private async requireAgent(id: string): Promise<ManagedAgent> {
    try {
      const agent = this.loadAgent ? await this.loadAgent(id) : this.agentManager.getAgent(id);
      if (!agent) throw new SideChatError("agent_missing", `Agent '${id}' is unavailable.`);
      return agent;
    } catch (error) {
      if (error instanceof SideChatError) throw error;
      // The storage-backed loader reports missing or archived records as plain
      // Errors; normalize them so callers can distinguish a stale sideAgentId
      // from a real load failure.
      const message = error instanceof Error ? error.message : String(error);
      if (message.startsWith("Agent not found:") || message.startsWith("Agent is archived:")) {
        throw new SideChatError("agent_missing", `Agent '${id}' is unavailable.`);
      }
      throw error;
    }
  }

  async listSupportedProviders(): Promise<string[]> {
    if (!this.providers || this.providers.expiresAt < Date.now()) {
      const promise = this.agentManager
        .listProviderAvailability()
        .then((entries) =>
          entries
            .filter((entry) => entry.available && SUPPORTED_SIDE_PROVIDERS[entry.provider])
            .map((entry) => entry.provider),
        );
      this.providers = { expiresAt: Date.now() + 30_000, promise };
    }
    return this.providers.promise;
  }

  private async snapshot(record: StoredSideChatRecord): Promise<SideChatSnapshot> {
    return {
      mainAgentId: record.mainAgentId,
      sideAgentId: record.sideAgentId,
      status: record.status,
      error: record.error,
      messages: structuredClone(record.messages),
      steeringProposal: record.steeringProposal,
      provider: record.provider,
      model: record.model,
      supportedProviders: await this.listSupportedProviders(),
    };
  }

  async get(mainAgentId: string): Promise<SideChatSnapshot> {
    const main = await this.requireAgent(mainAgentId);
    if (main.internal)
      throw new SideChatError("invalid_parent", "Side must be linked to a main session.");
    const active = this.turns.get(mainAgentId);
    if (active) return this.snapshot(active.record);
    await this.store.loadAll();
    const record = this.store.get(mainAgentId);
    if (record) {
      if (record.status === "running" && !this.busy.has(mainAgentId)) {
        record.status = "error";
        record.error = "Side was interrupted when the host stopped. Send a message to continue.";
        await this.store.save(record);
      }
      return this.snapshot(record);
    }
    const supportedProviders = await this.listSupportedProviders();
    const provider = supportedProviders.includes(main.provider) ? main.provider : null;
    return {
      mainAgentId,
      sideAgentId: null,
      status: "idle",
      error: null,
      messages: [],
      steeringProposal: null,
      provider,
      model: provider ? (main.runtimeInfo?.model ?? main.config.model ?? null) : null,
      supportedProviders,
    };
  }

  async send(
    mainAgentId: string,
    text: string,
    options: SendSideChatOptions = {},
  ): Promise<SideChatSnapshot> {
    const userText = text.trim();
    if (!userText || userText.length > 32_000)
      throw new SideChatError(
        "invalid_prompt",
        "Enter a Side message of at most 32,000 characters.",
      );
    if (this.busy.has(mainAgentId))
      throw new SideChatError(
        "busy",
        "Side is already responding. Stop it before sending another message.",
      );
    // Reserve before the first await: two clients must never start writers for the same native session.
    this.busy.add(mainAgentId);
    try {
      return await this.start(mainAgentId, userText, options);
    } catch (error) {
      this.busy.delete(mainAgentId);
      throw error;
    }
  }

  private async start(
    mainAgentId: string,
    userText: string,
    options: SendSideChatOptions,
  ): Promise<SideChatSnapshot> {
    const main = await this.requireAgent(mainAgentId);
    if (main.internal)
      throw new SideChatError("invalid_parent", "Side must be linked to a main session.");
    await this.store.loadAll();
    let record = this.store.get(mainAgentId);
    if (!record) {
      const supported = await this.listSupportedProviders();
      const provider = options.provider ?? main.provider;
      if (!supported.includes(provider))
        throw new SideChatError(
          "provider_unavailable",
          "Choose an available read-only provider for Side.",
        );
      const model =
        options.model ??
        (provider === main.provider ? (main.runtimeInfo?.model ?? main.config.model) : null) ??
        null;
      const now = new Date().toISOString();
      record = {
        mainAgentId,
        sideAgentId: null,
        status: "idle",
        error: null,
        messages: [],
        steeringProposal: null,
        checkpoint: null,
        provider,
        model,
        createdAt: now,
        updatedAt: now,
      };
    }
    const providerChanged = options.provider !== undefined && options.provider !== record.provider;
    const modelChanged = options.model !== undefined && options.model !== record.model;
    if (providerChanged || modelChanged)
      throw new SideChatError(
        "provider_locked",
        "This Side conversation already has a provider and model.",
      );
    const { side, recreated } = await this.resolveSideAgent(main, record);
    const promptText = recreated
      ? [
          "Earlier Side conversation for continuity:",
          JSON.stringify(
            record.messages.slice(-10).map((message) => ({
              role: message.role,
              text: message.text.slice(0, 1000),
            })),
          ),
          "Current Side user request:",
          userText,
        ].join("\n\n")
      : userText;
    const prepared = await prepareSidePrompt({
      mainAgentId,
      agentManager: this.agentManager,
      // A recreated side has no memory of the old context window; the stale
      // checkpoint would take the delta path and could emit only the user text.
      lastCheckpoint: recreated ? null : record.checkpoint,
      userText: promptText,
    });
    record.messages.push({ id: randomUUID(), role: "user", text: userText });
    record.status = "running";
    record.error = null;
    record.steeringProposal = null;
    record.updatedAt = new Date().toISOString();
    await this.store.save(record);
    const turn: ActiveSideTurn = { record, done: Promise.resolve(), limitError: null };
    this.turns.set(mainAgentId, turn);
    turn.done = this.execute(turn, side.id, prepared.prompt, prepared.checkpoint);
    // The request returns immediately; the daemon, not a WebSocket connection, owns generation.
    void turn.done.catch((error: unknown) =>
      this.logger?.error({ err: error, mainAgentId }, "Side persistence failed"),
    );
    if (options.wait) await turn.done;
    return this.snapshot(record);
  }

  private async resolveSideAgent(
    main: ManagedAgent,
    record: StoredSideChatRecord,
  ): Promise<{ side: ManagedAgent; recreated: boolean }> {
    let side: ManagedAgent | null = null;
    let recreated = false;
    if (record.sideAgentId) {
      try {
        side = await this.requireAgent(record.sideAgentId);
      } catch (error) {
        if (error instanceof SideChatError && error.code === "agent_missing") {
          record.sideAgentId = null;
          recreated = record.messages.length > 0;
        } else {
          throw error;
        }
      }
    }
    if (side) {
      verifySideIntegrity(side);
      return { side, recreated };
    }
    const provider = record.provider ?? main.provider;
    const resolved = this.resolveCreateConfig
      ? await this.resolveCreateConfig({ cwd: main.cwd, provider })
      : {};
    const config = buildSideProviderConfig({
      provider,
      cwd: main.cwd,
      model: record.model ?? undefined,
      modeId: resolved.modeId,
      featureValues: resolved.featureValues,
    });
    side = await this.agentManager.createAgent(config, undefined, {
      workspaceId: main.workspaceId,
      labels: { [SIDE_MAIN_AGENT_ID_LABEL]: record.mainAgentId },
      initialTitle: `Side: ${main.config.title ?? record.mainAgentId}`,
    });
    record.sideAgentId = side.id;
    record.model = side.config.model ?? record.model;
    await this.store.save(record);
    return { side, recreated };
  }

  private async execute(
    turn: ActiveSideTurn,
    sideId: string,
    prompt: string,
    checkpoint: StoredSideChatRecord["checkpoint"],
  ): Promise<void> {
    const record = turn.record;
    const reply = { id: randomUUID(), role: "assistant" as const, text: "" };
    const toolIds = new Set<string>();
    let started = false;
    const timeout = setTimeout(() => {
      turn.limitError =
        "Side reached its five-minute response limit. Ask a narrower question to continue.";
      void this.agentManager
        .cancelAgentRun(sideId)
        .catch((error: unknown) =>
          this.logger?.error({ err: error }, "Side timeout cancellation failed"),
        );
    }, 300_000);
    timeout.unref();
    try {
      const events = this.agentManager.streamAgent(sideId, prompt);
      for await (const event of events) {
        if (event.type === "turn_started") {
          started = true;
          record.checkpoint = checkpoint;
        }
        if (event.type === "turn_failed")
          throw new SideChatError("generation_failed", String(event.error));
        if (event.type !== "timeline") continue;
        if (event.item.type === "assistant_message") {
          if (reply.text.length === 0) record.messages.push(reply);
          reply.text += event.item.text;
        }
        if (event.item.type === "tool_call") toolIds.add(event.item.callId);
        const overBudget = toolIds.size > 24 || reply.text.length > 32_000;
        if (overBudget) {
          reply.text = reply.text.slice(0, 32_000);
          turn.limitError =
            "Side reached its inspection/output limit. Ask a narrower question to continue.";
          await this.agentManager.cancelAgentRun(sideId);
          break;
        }
      }
      const proposal = /<steer_proposal>([\s\S]*?)<\/steer_proposal>/i.exec(reply.text);
      if (proposal) {
        record.steeringProposal = proposal[1].trim().slice(0, 32_000) || null;
        reply.text = reply.text.replace(/<steer_proposal>[\s\S]*?<\/steer_proposal>/gi, "").trim();
      }
      if (turn.limitError) throw new SideChatError("budget_exceeded", turn.limitError);
      record.status = "idle";
    } catch (error) {
      record.status = "error";
      record.error = error instanceof Error ? error.message : String(error);
      this.logger?.warn({ err: error, mainAgentId: record.mainAgentId }, "Side response failed");
    } finally {
      clearTimeout(timeout);
      if (!started) record.checkpoint = null;
      record.updatedAt = new Date().toISOString();
      try {
        await this.store.save(record);
      } finally {
        this.turns.delete(record.mainAgentId);
        this.busy.delete(record.mainAgentId);
      }
    }
  }

  async stop(mainAgentId: string): Promise<SideChatSnapshot> {
    const turn = this.turns.get(mainAgentId);
    if (!turn) {
      if (this.busy.has(mainAgentId))
        throw new SideChatError("starting", "Side is starting. Try stopping it again shortly.");
      return this.get(mainAgentId);
    }
    const sideId = turn.record.sideAgentId;
    if (sideId) {
      const result = await this.agentManager.cancelAgentRun(sideId);
      if (result.status === "refused")
        throw new SideChatError("cancel_refused", "The provider could not stop Side. Try again.");
    }
    await turn.done;
    return this.snapshot(turn.record);
  }
}
