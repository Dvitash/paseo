import type { AgentManager } from "./agent/agent-manager.js";
import { stripInternalPaseoMcpServer } from "./agent/runtime-mcp-config.js";
import type {
  AgentPersistenceHandle,
  AgentProvider,
  AgentSessionConfig,
} from "./agent/agent-sdk-types.js";
import type { AgentStorage, StoredAgentRecord } from "./agent/agent-storage.js";

interface LoggerLike {
  child(bindings: Record<string, unknown>): LoggerLike;
  error(...args: unknown[]): void;
  warn(...args: unknown[]): void;
}

function getLogger(logger: LoggerLike): LoggerLike {
  return logger.child({ module: "persistence" });
}

type AgentStoragePersistence = Pick<AgentStorage, "applySnapshot" | "list">;
type AgentManagerStateSource = Pick<AgentManager, "subscribe">;

interface BuildSessionConfigOptions {
  validProviders?: Iterable<AgentProvider>;
}

function isProviderRegistered(
  validProviders: Iterable<AgentProvider> | undefined,
  provider: AgentProvider,
): boolean {
  if (!validProviders) {
    return true;
  }
  if (validProviders instanceof Set) {
    return validProviders.has(provider);
  }
  return new Set(validProviders).has(provider);
}

/**
 * Attach AgentStorage persistence to an AgentManager instance so every
 * agent_state snapshot is flushed to disk.
 */
export function attachAgentStoragePersistence(
  logger: LoggerLike,
  agentManager: AgentManagerStateSource,
  storage: AgentStoragePersistence,
): () => void {
  const log = getLogger(logger);
  const unsubscribe = agentManager.subscribe((event) => {
    if (event.type !== "agent_state") {
      return;
    }
    if (event.agent.lifecycle === "closed") {
      return;
    }
    void storage.applySnapshot(event.agent).catch((error) => {
      log.error({ err: error, agentId: event.agent.id }, "Failed to persist agent snapshot");
    });
  });

  return unsubscribe;
}

const CONFIG_PASSTHROUGH_KEYS = [
  "modeId",
  "model",
  "thinkingOptionId",
  "featureValues",
  "providerOptions",
  "toolPolicy",
  "systemPrompt",
  "paseoToolPolicy",
] as const satisfies readonly (keyof NonNullable<StoredAgentRecord["config"]>)[];

export function buildConfigOverrides(record: StoredAgentRecord): Partial<AgentSessionConfig> {
  const cfg = record.config;
  const isReadOnly = cfg?.readOnly === true;
  const overrides: Partial<AgentSessionConfig> = {
    provider: record.provider,
    cwd: record.cwd,
    mcpServers: isReadOnly ? {} : (cfg?.mcpServers ?? undefined),
    readOnly: isReadOnly ? true : undefined,
    durableInternal: cfg?.durableInternal === true ? true : undefined,
    internal: record.internal,
  };
  for (const key of CONFIG_PASSTHROUGH_KEYS) {
    const value = cfg?.[key];
    if (value !== null && value !== undefined) {
      (overrides as Record<string, unknown>)[key] = value;
    }
  }
  return stripInternalPaseoMcpServer(overrides as AgentSessionConfig);
}

export function buildSessionConfig(
  record: StoredAgentRecord,
  options?: BuildSessionConfigOptions,
): AgentSessionConfig | null {
  if (!isProviderRegistered(options?.validProviders, record.provider)) {
    return null;
  }
  const overrides = buildConfigOverrides(record);
  const isReadOnly = overrides.readOnly === true;
  return stripInternalPaseoMcpServer({
    provider: record.provider,
    cwd: record.cwd,
    modeId: overrides.modeId,
    model: overrides.model,
    thinkingOptionId: overrides.thinkingOptionId,
    featureValues: overrides.featureValues,
    providerOptions: overrides.providerOptions,
    toolPolicy: overrides.toolPolicy,
    systemPrompt: overrides.systemPrompt,
    mcpServers: isReadOnly ? {} : overrides.mcpServers,
    readOnly: isReadOnly ? true : undefined,
    durableInternal: overrides.durableInternal,
    paseoToolPolicy: overrides.paseoToolPolicy,
    internal: overrides.internal,
  });
}

export function isStoredAgentProviderAvailable(
  record: StoredAgentRecord,
  validProviders?: Iterable<AgentProvider>,
): boolean {
  return isProviderRegistered(validProviders, record.provider);
}

export function extractTimestamps(record: StoredAgentRecord): {
  createdAt: Date;
  updatedAt: Date;
  lastUserMessageAt: Date | null;
  labels?: Record<string, string>;
  workspaceId?: string;
  owner?: StoredAgentRecord["owner"];
} {
  return {
    createdAt: new Date(record.createdAt),
    updatedAt: new Date(record.lastActivityAt ?? record.updatedAt),
    lastUserMessageAt: record.lastUserMessageAt ? new Date(record.lastUserMessageAt) : null,
    labels: record.labels,
    workspaceId: record.workspaceId,
    owner: record.owner,
  };
}

export function toAgentPersistenceHandle(
  registeredProviders: Iterable<AgentProvider>,
  handle: StoredAgentRecord["persistence"],
): AgentPersistenceHandle | null {
  if (!handle) {
    return null;
  }
  const provider = handle.provider;
  if (!isProviderRegistered(registeredProviders, provider)) {
    return null;
  }
  if (!handle.sessionId) {
    return null;
  }
  return {
    provider,
    sessionId: handle.sessionId,
    ...(handle.nativeHandle !== undefined ? { nativeHandle: handle.nativeHandle } : {}),
    ...(handle.metadata !== undefined ? { metadata: handle.metadata } : {}),
  } satisfies AgentPersistenceHandle;
}
