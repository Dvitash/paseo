import { describe, expect, test, vi } from "vitest";
import pino from "pino";
import type { AgentSession } from "../agent-sdk-types.js";
import type { Query, Options as ClaudeOptions } from "@anthropic-ai/claude-agent-sdk";
import type { ClaudeQueryFactory } from "./claude/query.js";
import type { StoredAgentRecord } from "../agent-storage.js";
import { buildConfigOverrides, buildSessionConfig } from "../../persistence-hooks.js";
import { ClaudeAgentClient } from "./claude/agent.js";
import { CodexAppServerAgentClient } from "./codex-app-server-agent.js";
import { createFakeCodexAppServer } from "./codex/test-utils/fake-app-server.js";
import { OpenCodeAgentClient } from "./opencode-agent.js";
import {
  TestOpenCodeClient,
  TestOpenCodeHarness,
} from "./opencode/test-utils/test-opencode-harness.js";

const logger = pino({ level: "silent" });

function createStubClaudeQuery(): Query {
  return {
    [Symbol.asyncIterator]: async function* () {},
    interrupt: vi.fn(),
    close: vi.fn(),
    supportedCommands: vi.fn(async () => []),
    setPermissionMode: vi.fn(async () => {}),
  } as unknown as Query;
}

describe("Claude ReadOnly Adapter Enforcement", () => {
  test("buildOptions forces strict isolation, tools allowlist, and empty MCP servers", async () => {
    const queryReturn = vi.fn().mockResolvedValue(undefined);
    const queryFactory = vi.fn(() => ({
      close: vi.fn(),
      return: queryReturn,
      supportedCommands: vi.fn().mockResolvedValue([]),
      setPermissionMode: vi.fn().mockResolvedValue(undefined),
    }));

    const claudeClient = new ClaudeAgentClient({
      logger,
      resolveBinary: async () => "/bin/claude",
      queryFactory: queryFactory as unknown as ClaudeQueryFactory,
    });

    const session = await claudeClient.createSession({
      provider: "claude",
      cwd: process.cwd(),
      readOnly: true,
      mcpServers: {
        testMcp: { type: "stdio", command: "test", args: [] },
      },
    });

    await (session as unknown as { ensureQuery(): Promise<unknown> }).ensureQuery();

    const options = queryFactory.mock.calls[0]?.[0].options as ClaudeOptions;
    expect(options).toBeDefined();
    expect(options.permissionMode).toBe("plan");
    expect(options.allowDangerouslySkipPermissions).toBe(false);
    expect(options.strictMcpConfig).toBe(true);
    expect(options.mcpServers).toEqual({});
    expect(options.settingSources).toEqual([]);
    expect(options.tools).toEqual(["Read", "Grep", "Glob"]);
    expect(options.disallowedTools).toEqual(
      expect.arrayContaining([
        "Write",
        "Edit",
        "Bash",
        "NotebookEdit",
        "KillProcess",
        "Task",
        "Agent",
      ]),
    );
    expect(options.skills).toEqual([]);
    expect(options.plugins).toEqual([]);
    expect(options.agents).toBeUndefined();
    expect(options.sandbox).toMatchObject({
      enabled: true,
      filesystem: {
        allowWrite: [],
        denyWrite: ["*"],
      },
    });
    expect(options.settings).toMatchObject({
      disableAllHooks: true,
      permissions: {
        deny: expect.arrayContaining(["Write", "Edit", "Bash"]),
      },
    });

    await session.close();
  });

  test("setMode is rejected with error in read-only mode", async () => {
    const claudeClient = new ClaudeAgentClient({
      logger,
      resolveBinary: async () => "/bin/claude",
      queryFactory: () => createStubClaudeQuery(),
    });

    const session = await claudeClient.createSession({
      provider: "claude",
      cwd: process.cwd(),
      readOnly: true,
    });

    await expect(session.setMode("acceptEdits")).rejects.toThrow(
      "Cannot change mode of read-only Claude agent session",
    );
    await session.close();
  });

  test("respondToPermission blocks plan implementation approval in read-only mode", async () => {
    const claudeClient = new ClaudeAgentClient({
      logger,
      resolveBinary: async () => "/bin/claude",
      queryFactory: () => createStubClaudeQuery(),
    });

    const session = await claudeClient.createSession({
      provider: "claude",
      cwd: process.cwd(),
      readOnly: true,
    });

    (session as unknown as { pendingPermissions: Map<string, unknown> }).pendingPermissions.set(
      "plan-1",
      {
        request: { kind: "plan", id: "plan-1" },
        cleanup: vi.fn(),
      },
    );

    await expect(
      session.respondToPermission("plan-1", { behavior: "allow", selectedActionId: "implement" }),
    ).rejects.toThrow("Cannot approve plan implementation in read-only Claude agent session");
    await session.close();
  });
});

describe("Codex ReadOnly Adapter Enforcement", () => {
  test("CodexAppServerAgentClient.resumeSession locks readOnly and strips mcpServers using fake app server", async () => {
    const appServer = createFakeCodexAppServer({
      "config/read": () => ({
        config: {
          sandbox_workspace_write: {},
          mcp_servers: {
            global_db: {},
            project_tools: {},
          },
        },
      }),
      "thread/read": () => ({
        thread: {
          id: "11111111-1111-4111-8111-111111111111",
          historyMode: "complete",
          turns: [],
        },
      }),
      "thread/resume": () => ({
        thread: { id: "11111111-1111-4111-8111-111111111111" },
      }),
      "thread/loaded/list": () => ({ data: [] }),
    });

    const codexClient = new CodexAppServerAgentClient(logger);
    const internals = codexClient as unknown as {
      goalsEnabledPromise: Promise<boolean> | null;
      autoReviewEnabledPromise: Promise<boolean> | null;
      spawnAppServer: () => Promise<unknown>;
    };
    internals.goalsEnabledPromise = Promise.resolve(false);
    internals.autoReviewEnabledPromise = Promise.resolve(false);
    internals.spawnAppServer = async () => appServer.child;

    let session: AgentSession | null = null;
    try {
      session = await codexClient.resumeSession(
        {
          sessionId: "11111111-1111-4111-8111-111111111111",
          metadata: { cwd: "/tmp/project", readOnly: true },
        },
        { readOnly: false as unknown as boolean },
      );

      expect(session.config.readOnly).toBe(true);
      expect(session.config.mcpServers).toEqual({});

      await expect(session.setMode("workspace-write")).rejects.toThrow(
        "Cannot change mode of read-only Codex agent session",
      );

      await expect(session.respondToPermission("perm-1", { behavior: "allow" })).rejects.toThrow();

      const handle = session.describePersistence();
      expect(handle?.metadata?.readOnly).toBe(true);
      expect(handle?.metadata?.mcpServers).toEqual({});
    } finally {
      await session?.close().catch(() => undefined);
      appServer.disconnect();
    }
  });

  test("loadResolvedWorkspaceWrite fails closed when config/read fails or is missing config", async () => {
    const appServer = createFakeCodexAppServer({
      "config/read": () => ({}),
      "thread/read": () => ({
        thread: {
          id: "22222222-2222-4222-8222-222222222222",
          historyMode: "complete",
          turns: [],
        },
      }),
      "thread/resume": () => ({
        thread: { id: "22222222-2222-4222-8222-222222222222" },
      }),
      "thread/loaded/list": () => ({ data: [] }),
    });

    const codexClient = new CodexAppServerAgentClient(logger);
    const internals = codexClient as unknown as {
      goalsEnabledPromise: Promise<boolean> | null;
      autoReviewEnabledPromise: Promise<boolean> | null;
      spawnAppServer: () => Promise<unknown>;
    };
    internals.goalsEnabledPromise = Promise.resolve(false);
    internals.autoReviewEnabledPromise = Promise.resolve(false);
    internals.spawnAppServer = async () => appServer.child;

    let session: AgentSession | null = null;
    try {
      await expect(
        codexClient.resumeSession({
          sessionId: "22222222-2222-4222-8222-222222222222",
          metadata: { cwd: "/tmp/project", readOnly: true },
        }),
      ).rejects.toThrow(/Failed to read native Codex configuration for read-only isolation/);
    } finally {
      await session?.close().catch(() => undefined);
      appServer.disconnect();
    }
  });
});

describe("OpenCode ReadOnly Adapter Enforcement", () => {
  test("createSession sends read-only permission ruleset and disables bridge", async () => {
    const harness = new TestOpenCodeHarness();
    const fakeClient = new TestOpenCodeClient();
    fakeClient.sessionCreateResponse = { data: { id: "opencode-session-1" } };
    harness.enqueueClient(fakeClient);

    const opencodeClient = new OpenCodeAgentClient(logger, undefined, {
      serverManager: harness,
      createClient: harness.createClient,
    });

    const session = await opencodeClient.createSession({
      provider: "opencode",
      cwd: "/workspace/repo",
      readOnly: true,
      mcpServers: {
        testMcp: { command: "test", args: [] },
      },
    });

    expect(fakeClient.calls.sessionCreate).toHaveLength(1);
    const createCall = fakeClient.calls.sessionCreate[0] as {
      directory: string;
      permission?: Array<{ permission: string; action: string }>;
    };
    expect(createCall.permission).toEqual([
      { permission: "*", pattern: "*", action: "deny" },
      { permission: "read", pattern: "*", action: "allow" },
      { permission: "glob", pattern: "*", action: "allow" },
      { permission: "grep", pattern: "*", action: "allow" },
      { permission: "list", pattern: "*", action: "allow" },
    ]);

    await expect(session.setMode("build")).rejects.toThrow(
      "Cannot change mode of read-only OpenCode agent session",
    );
    await expect(session.setFeature("auto_accept", true)).rejects.toThrow(
      "Cannot enable auto-accept in read-only OpenCode agent session",
    );

    await session.close();
  });

  test("resumeSession updates permissions on session and locks readOnly", async () => {
    const harness = new TestOpenCodeHarness();
    const fakeClient = new TestOpenCodeClient();
    fakeClient.sessionUpdateResponse = { data: {} };
    harness.enqueueClient(fakeClient);

    const opencodeClient = new OpenCodeAgentClient(logger, undefined, {
      serverManager: harness,
      createClient: harness.createClient,
    });

    const session = await opencodeClient.resumeSession(
      {
        provider: "opencode",
        sessionId: "opencode-session-1",
        metadata: { cwd: "/workspace/repo", readOnly: true },
      },
      { readOnly: false as unknown as boolean },
    );

    expect(session.config.readOnly).toBe(true);
    expect(session.config.mcpServers).toEqual({});
    expect(fakeClient.calls.sessionUpdate).toHaveLength(1);
    const updateCall = fakeClient.calls.sessionUpdate[0] as {
      sessionID: string;
      permission?: Array<{ permission: string; action: string }>;
    };
    expect(updateCall.sessionID).toBe("opencode-session-1");
    expect(updateCall.permission).toEqual([
      { permission: "*", pattern: "*", action: "deny" },
      { permission: "read", pattern: "*", action: "allow" },
      { permission: "glob", pattern: "*", action: "allow" },
      { permission: "grep", pattern: "*", action: "allow" },
      { permission: "list", pattern: "*", action: "allow" },
    ]);

    const handle = session.describePersistence();
    expect(handle?.metadata?.readOnly).toBe(true);

    await session.close();
  });

  test("resumeSession fails closed if permission update returns error", async () => {
    const harness = new TestOpenCodeHarness();
    const fakeClient = new TestOpenCodeClient();
    fakeClient.sessionUpdateResponse = { error: { message: "update failed" } };
    harness.enqueueClient(fakeClient);

    const opencodeClient = new OpenCodeAgentClient(logger, undefined, {
      serverManager: harness,
      createClient: harness.createClient,
    });

    await expect(
      opencodeClient.resumeSession({
        provider: "opencode",
        sessionId: "opencode-session-fail",
        metadata: { cwd: "/workspace/repo", readOnly: true },
      }),
    ).rejects.toThrow(/Failed to enforce read-only permissions on OpenCode session resume/);
  });
});

describe("Persistence Hooks ReadOnly and Internal Invariants", () => {
  test("buildConfigOverrides and buildSessionConfig preserve readOnly and internal across restart", () => {
    const record: StoredAgentRecord = {
      id: "side-agent-1",
      provider: "claude",
      cwd: "/tmp/project",
      createdAt: "2026-09-08T10:00:00.000Z",
      updatedAt: "2026-09-08T10:00:00.000Z",
      labels: { "paseo.side.read_only": "true" },
      lastStatus: "closed",
      internal: true,
      config: {
        model: "claude-3-5-sonnet",
        readOnly: true,
        mcpServers: { shouldBeCleared: {} },
      },
    };

    const overrides = buildConfigOverrides(record);
    expect(overrides.readOnly).toBe(true);
    expect(overrides.internal).toBe(true);
    expect(overrides.mcpServers).toEqual({});

    const sessionConfig = buildSessionConfig(record);
    expect(sessionConfig).not.toBeNull();
    expect(sessionConfig?.readOnly).toBe(true);
    expect(sessionConfig?.internal).toBe(true);
    expect(sessionConfig?.mcpServers).toEqual({});
  });

  test("Client resumeSession cannot widen readOnly even if overrides specify readOnly: false", async () => {
    const claudeClient = new ClaudeAgentClient({
      logger,
      resolveBinary: async () => "/bin/claude",
      queryFactory: () => createStubClaudeQuery(),
    });

    const resumedClaude = await claudeClient.resumeSession(
      {
        provider: "claude",
        sessionId: "claude-1",
        metadata: { cwd: "/tmp/project", readOnly: true },
      },
      { readOnly: false as unknown as boolean },
    );
    expect(resumedClaude.config.readOnly).toBe(true);
    expect(resumedClaude.config.mcpServers).toEqual({});
    await resumedClaude.close();
  });
});
