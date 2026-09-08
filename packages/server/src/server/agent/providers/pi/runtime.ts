import type {
  PiAgentMessage,
  PiModel,
  PiPromptAck,
  PiRpcSlashCommand,
  PiRuntimeEvent,
  PiSessionState,
  PiSessionStats,
} from "./rpc-types.js";
import type { ProviderRuntimeSettings } from "../../provider-launch-config.js";

export interface PiRuntimeLaunch {
  cwd: string;
  argv: string[];
  env?: Record<string, string>;
  protocolMode?: "rpc" | "rpc-ui";
  model?: string;
  thinkingOptionId?: string;
  modeId?: string;
  session?: string;
  noSession?: boolean;
  mcpConfigPath?: string;
  extensionPaths?: string[];
  extraArgs?: string[];
  readOnly?: boolean;
  tools?: string[];
}

export interface PiStartSessionInput {
  cwd: string;
  signal?: AbortSignal;
  env?: Record<string, string>;
  protocolMode?: "rpc" | "rpc-ui";
  model?: string;
  thinkingOptionId?: string;
  modeId?: string;
  session?: string;
  noSession?: boolean;
  mcpConfigPath?: string;
  extensionPaths?: string[];
  extraArgs?: string[];
  readOnly?: boolean;
  tools?: string[];
}

export interface PiRuntimeSession {
  onEvent(callback: (event: PiRuntimeEvent) => void): () => void;
  prompt(
    message: string,
    images?: Array<{ type: "image"; data: string; mimeType: string }>,
  ): Promise<PiPromptAck>;
  steer(
    message: string,
    images?: Array<{ type: "image"; data: string; mimeType: string }>,
  ): Promise<void>;
  clearQueue(): Promise<void>;
  compact(customInstructions?: string): Promise<void>;
  setAutoCompaction(enabled: boolean): Promise<void>;
  abort(): Promise<void>;
  getState(): Promise<PiSessionState>;
  getMessages(): Promise<PiAgentMessage[]>;
  getAvailableModels(timeoutMs?: number | null): Promise<PiModel[]>;
  setModel(provider: string, modelId: string): Promise<PiModel>;
  setThinkingLevel(level: string): Promise<void>;
  getSessionStats(): Promise<PiSessionStats>;
  getCommands(): Promise<PiRpcSlashCommand[]>;
  request(
    command: { type: string; [key: string]: unknown },
    timeoutMs?: number | null,
  ): Promise<unknown>;
  sendRawFrame(frame: object & { type: string }): void;
  respondToExtensionUiRequest(
    id: string,
    response: { value?: string; confirmed?: boolean; cancelled?: boolean },
  ): void;
  cancelExtensionUiRequest(id: string): void;
  close(): Promise<void>;
}

export interface PiRuntime {
  startSession(input: PiStartSessionInput): Promise<PiRuntimeSession>;
}

export function buildPiLaunch(input: {
  command: [string, ...string[]];
  runtimeSettings?: ProviderRuntimeSettings;
  session: PiStartSessionInput;
}): PiRuntimeLaunch {
  const command =
    input.runtimeSettings?.command?.mode === "replace" && input.runtimeSettings.command.argv[0]
      ? input.runtimeSettings.command.argv
      : input.command;
  const binary = command[0];
  const commandArgs = input.session.readOnly
    ? sanitizePiReadOnlyExtraArgs(command.slice(1))
    : command.slice(1);
  const argv = [binary, ...commandArgs];

  const protocolMode = input.session.protocolMode ?? "rpc";
  appendPiLaunchArgs(argv, input.session, protocolMode);

  return {
    cwd: input.session.cwd,
    argv,
    env:
      input.runtimeSettings?.env || input.session.env
        ? {
            ...input.runtimeSettings?.env,
            ...input.session.env,
          }
        : undefined,
    model: input.session.model,
    thinkingOptionId: input.session.thinkingOptionId,
    protocolMode,
    modeId: input.session.modeId,
    session: input.session.session,
    noSession: input.session.noSession,
    mcpConfigPath: input.session.mcpConfigPath,
    extensionPaths: input.session.extensionPaths,
    extraArgs: input.session.extraArgs,
    readOnly: input.session.readOnly,
    tools: input.session.tools,
  };
}

function appendPiLaunchArgs(
  argv: string[],
  session: PiStartSessionInput,
  protocolMode: "rpc" | "rpc-ui",
): void {
  if (!hasModeFlag(argv)) {
    argv.push("--mode", protocolMode);
  }
  if (session.readOnly) {
    appendPiReadOnlyLaunchArgs(argv, session);
  } else {
    appendPiNormalLaunchArgs(argv, session);
  }
}

function appendPiReadOnlyLaunchArgs(argv: string[], session: PiStartSessionInput): void {
  const defaultReadOnlyTools = ["read", "grep", "find", "ls"];
  const tools =
    session.tools && session.tools.length > 0
      ? session.tools.filter((t) => !PI_MUTATING_TOOLS[t])
      : defaultReadOnlyTools;
  argv.push("--tools", tools.join(","));
  argv.push("--no-extensions");
  argv.push("--no-skills");
  argv.push("--no-prompt-templates");
  argv.push("--no-themes");
  argv.push("--no-context-files");
  for (const extensionPath of session.extensionPaths ?? []) {
    argv.push("--extension", extensionPath);
  }
  if (session.extraArgs?.length) {
    argv.push(...sanitizePiReadOnlyExtraArgs(session.extraArgs));
  }
  appendPiModelAndSessionArgs(argv, session);
}

function appendPiNormalLaunchArgs(argv: string[], session: PiStartSessionInput): void {
  if (session.extraArgs?.length) {
    argv.push(...session.extraArgs);
  }
  appendPiModelAndSessionArgs(argv, session);
  if (session.mcpConfigPath) {
    argv.push("--mcp-config", session.mcpConfigPath);
  }
  for (const extensionPath of session.extensionPaths ?? []) {
    argv.push("--extension", extensionPath);
  }
}

function appendPiModelAndSessionArgs(argv: string[], session: PiStartSessionInput): void {
  if (session.model) {
    argv.push("--model", session.model);
  }
  if (session.thinkingOptionId) {
    argv.push("--thinking", session.thinkingOptionId);
  }
  if (session.noSession) {
    argv.push("--no-session");
  } else if (session.session) {
    argv.push("--session", session.session);
  }
}

function hasModeFlag(argv: string[]): boolean {
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--mode") {
      return true;
    }
    if (argv[i]?.startsWith("--mode=")) {
      return true;
    }
  }
  return false;
}

const PI_MUTATING_TOOLS: Record<string, true> = {
  bash: true,
  powershell: true,
  edit: true,
  write: true,
};

const PI_READONLY_DENIED_FLAGS: Record<string, true> = {
  "--tools": true,
  "-t": true,
  "--exclude-tools": true,
  "-xt": true,
  "--no-builtin-tools": true,
  "-nbt": true,
  "--extension": true,
  "-e": true,
  "--no-extensions": true,
  "-ne": true,
  "--skill": true,
  "--no-skills": true,
  "-ns": true,
  "--prompt-template": true,
  "--no-prompt-templates": true,
  "-np": true,
  "--mcp-config": true,
  "--mode": true,
  "--theme": true,
  "--use-theme": true,
  "--no-themes": true,
  "--no-context-files": true,
  "-nc": true,
};

const PI_READONLY_VALUE_FLAGS: Record<string, true> = {
  "--tools": true,
  "-t": true,
  "--exclude-tools": true,
  "-xt": true,
  "--extension": true,
  "-e": true,
  "--skill": true,
  "--prompt-template": true,
  "--mcp-config": true,
  "--mode": true,
  "--theme": true,
  "--use-theme": true,
};

export function sanitizePiReadOnlyExtraArgs(args: readonly string[]): string[] {
  const sanitized: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg) continue;
    const equalsIndex = arg.indexOf("=");
    const flag = equalsIndex === -1 ? arg : arg.slice(0, equalsIndex);
    if (PI_READONLY_DENIED_FLAGS[flag]) {
      if (equalsIndex === -1 && PI_READONLY_VALUE_FLAGS[flag]) {
        i += 1;
      }
      continue;
    }
    sanitized.push(arg);
  }
  return sanitized;
}
