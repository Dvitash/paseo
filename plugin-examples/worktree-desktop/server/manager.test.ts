import type { PluginHookWorkspace, PluginSessionOpenRequest } from "@getpaseo/plugin/server";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DesktopManager, type DesktopManagerOptions } from "./manager";

class TestScheduler {
  time = 0;
  readonly tasks = new Set<() => void>();
  readonly schedule = (callback: () => void) => {
    this.tasks.add(callback);
    return () => {
      this.tasks.delete(callback);
    };
  };
  runNext() {
    const callback = this.tasks.values().next().value;
    if (!callback) throw new Error("No scheduled desktop readiness check");
    this.tasks.delete(callback);
    callback();
  }
}

class ControlledProbe {
  private readonly pending: Array<(ready: boolean) => void> = [];
  readonly check = () =>
    new Promise<boolean>((resolve) => {
      this.pending.push(resolve);
    });
  complete(ready: boolean) {
    const resolve = this.pending.shift();
    if (!resolve) throw new Error("No pending desktop HTTP probe");
    resolve(ready);
  }
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("worktree desktop lifecycle", () => {
  let root: string;
  let workspace: PluginHookWorkspace;
  let scheduler: TestScheduler;
  const managers: DesktopManager[] = [];

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "paseo-desktop-lifecycle-"));
    workspace = {
      id: "ws-one",
      projectId: "project-one",
      cwd: join(root, "worktree"),
      name: "Feature worktree",
      archivedAt: null,
    };
    scheduler = new TestScheduler();
  });
  afterEach(() => {
    for (const manager of managers.splice(0)) manager.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  function createManager(options: DesktopManagerOptions = {}) {
    const manager = new DesktopManager({
      baseDir: root,
      cliPath: "/owned/desktop-cli",
      xauthority: "/owned/Xauthority",
      execFile: (_file, _args, callback) => callback(null, "", ""),
      probe: async () => true,
      isWorktreePath: () => true,
      now: () => scheduler.time,
      schedule: scheduler.schedule,
      startupTimeoutMs: 1000,
      ...options,
    });
    managers.push(manager);
    return manager;
  }

  function writeState(overrides: Record<string, unknown> = {}) {
    const directory = join(root, "desktop-one");
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, "state.json"),
      JSON.stringify({
        display: 109,
        port: 48689,
        slug: "desktop-one",
        worktree_path: workspace.cwd,
        browser_enabled: true,
        browser_url: "https://spark.tailnet.ts.net:20109/",
        browser_unit: "owned-stream.service",
        ...overrides,
      }),
    );
  }

  it("starts once with exact worktree arguments, preserving names containing spaces", () => {
    const commands: Array<{ file: string; args: string[] }> = [];
    const manager = createManager({
      execFile: (file, args) => {
        commands.push({ file, args });
      },
    });
    manager.onWorkspaceCreated({ workspace });
    manager.onWorkspaceCreated({ workspace });
    expect(commands).toEqual([
      {
        file: "/owned/desktop-cli",
        args: ["start", "Feature worktree", "--worktree", workspace.cwd],
      },
    ]);
  });

  it("does not add an empty positional name and ignores unsupported directories", () => {
    const commands: string[][] = [];
    const manager = createManager({
      execFile: (_file, args) => {
        commands.push(args);
      },
    });
    manager.onWorkspaceCreated({ workspace: { ...workspace, name: null } });
    createManager({
      isWorktreePath: () => false,
      execFile: (_file, args) => {
        commands.push(args);
      },
    }).onWorkspaceCreated({ workspace });
    expect(commands).toEqual([["start", "--worktree", workspace.cwd]]);
  });

  it("waits for HTTP200 rather than trusting state or launcher completion", async () => {
    writeState();
    let ready = false;
    const manager = createManager({ probe: async () => ready });
    const baseline = manager.pollEvents(null).cursor;
    manager.onWorkspaceCreated({ workspace });
    await flushMicrotasks();
    expect(manager.pollEvents(baseline).workspaceIds).toEqual([]);
    expect(await manager.getStatus(workspace.id, workspace.cwd)).toEqual({ status: "starting" });
    ready = true;
    scheduler.runNext();
    await flushMicrotasks();
    expect(manager.pollEvents(baseline).workspaceIds).toEqual([workspace.id]);
    expect(await manager.getStatus(workspace.id, workspace.cwd)).toEqual({
      status: "ready",
      url: "https://spark.tailnet.ts.net:20109/",
    });
    expect(scheduler.tasks.size).toBe(0);
  });

  it("bounds startup even when the launcher never invokes its completion callback", async () => {
    const manager = createManager({ execFile: () => {} });
    const baseline = manager.pollEvents(null).cursor;
    manager.onWorkspaceCreated({ workspace });
    await flushMicrotasks();
    scheduler.time = 1001;
    scheduler.runNext();
    await flushMicrotasks();
    expect(manager.pollEvents(baseline).workspaceIds).toEqual([workspace.id]);
    expect(await manager.getStatus(workspace.id, workspace.cwd)).toEqual({
      status: "error",
      message:
        "Desktop start failed: Desktop stream did not become ready before the startup timeout. Retry after checking the desktop service.",
    });
    expect(scheduler.tasks.size).toBe(0);
  });

  it("recovers on Retry after startup times out without launching another desktop", async () => {
    writeState();
    let ready = false;
    const commands: string[][] = [];
    const manager = createManager({
      probe: async () => ready,
      execFile: (_file, args) => {
        commands.push(args);
      },
    });
    manager.onWorkspaceCreated({ workspace });
    await flushMicrotasks();
    scheduler.time = 1001;
    scheduler.runNext();
    await flushMicrotasks();
    expect((await manager.getStatus(workspace.id, workspace.cwd)).status).toBe("error");
    ready = true;
    expect(await manager.getStatus(workspace.id, workspace.cwd)).toEqual({
      status: "ready",
      url: "https://spark.tailnet.ts.net:20109/",
    });
    expect(commands).toEqual([["start", "Feature worktree", "--worktree", workspace.cwd]]);
  });

  it("turns launcher failure into one visible error event, without replay on plugin load", async () => {
    const manager = createManager({
      execFile: (_file, _args, callback) => callback(new Error("service launch failed"), "", ""),
    });
    const baseline = manager.pollEvents(null).cursor;
    manager.onWorkspaceCreated({ workspace });
    manager.onWorkspaceCreated({ workspace });
    expect(manager.pollEvents(baseline).workspaceIds).toEqual([workspace.id]);
    expect(manager.pollEvents(null).workspaceIds).toEqual([]);
    expect(await manager.getStatus(workspace.id, workspace.cwd)).toEqual({
      status: "error",
      message: "Desktop start failed: service launch failed",
    });
  });

  it("publishes a visible failure if the readiness adapter rejects, instead of silently stopping", async () => {
    writeState();
    const manager = createManager({
      probe: async () => {
        throw new Error("probe failed");
      },
    });
    const baseline = manager.pollEvents(null).cursor;
    manager.onWorkspaceCreated({ workspace });
    await flushMicrotasks();
    expect(manager.pollEvents(baseline).workspaceIds).toEqual([workspace.id]);
    expect(scheduler.tasks.size).toBe(0);
  });

  it("does not publish or reschedule after an in-flight probe finishes for an archived workspace", async () => {
    writeState();
    const probe = new ControlledProbe();
    const commands: string[][] = [];
    const manager = createManager({
      probe: probe.check,
      execFile: (_file, args) => {
        commands.push(args);
      },
    });
    const baseline = manager.pollEvents(null).cursor;
    manager.onWorkspaceCreated({ workspace });
    manager.onWorkspaceArchived({ workspace });
    probe.complete(true);
    await flushMicrotasks();
    expect(manager.pollEvents(baseline).workspaceIds).toEqual([]);
    expect(scheduler.tasks.size).toBe(0);
    expect(commands).toEqual([
      ["start", "Feature worktree", "--worktree", workspace.cwd],
      ["destroy", "--worktree", workspace.cwd],
    ]);
  });

  it("cancels scheduled checks and drops queued events on archive", async () => {
    const manager = createManager();
    const baseline = manager.pollEvents(null).cursor;
    manager.onWorkspaceCreated({ workspace });
    await flushMicrotasks();
    expect(scheduler.tasks.size).toBe(1);
    manager.onWorkspaceArchived({ workspace });
    expect(scheduler.tasks.size).toBe(0);
    expect(manager.pollEvents(baseline).workspaceIds).toEqual([]);
  });

  it("unloads without destroying desktops or accepting late launcher failures", async () => {
    const callbacks: Array<(error: Error | null, stdout: string, stderr: string) => void> = [];
    const commands: string[][] = [];
    const manager = createManager({
      execFile: (_file, args, callback) => {
        commands.push(args);
        callbacks.push(callback);
      },
    });
    const baseline = manager.pollEvents(null).cursor;
    manager.onWorkspaceCreated({ workspace });
    await flushMicrotasks();
    manager.dispose();
    const complete = callbacks[0];
    if (!complete) throw new Error("Expected desktop launch");
    complete(new Error("late failure"), "", "");
    manager.onWorkspaceArchived({ workspace });
    expect(scheduler.tasks.size).toBe(0);
    expect(manager.pollEvents(baseline).workspaceIds).toEqual([]);
    expect(commands).toEqual([["start", "Feature worktree", "--worktree", workspace.cwd]]);
  });

  it("preserves all session fields while injecting the matching worktree display", () => {
    writeState();
    const request: PluginSessionOpenRequest = {
      agentId: "agent-one",
      workspaceId: workspace.id,
      provider: "codex",
      cwd: workspace.cwd,
      reason: "create",
      purpose: "interactive",
      env: { KEEP: "yes" },
    };
    expect(createManager().onAgentSessionOpen(request)).toEqual({
      ...request,
      env: {
        KEEP: "yes",
        DISPLAY: ":109",
        XAUTHORITY: "/owned/Xauthority",
        SPARK_WORKTREE_SLUG: "desktop-one",
        SPARK_WORKTREE_PORT: "48689",
      },
    });
    const unmatched = { ...request, cwd: join(root, "other-worktree") };
    expect(createManager().onAgentSessionOpen(unmatched)).toBe(unmatched);
  });

  it("reports missing and stale desktops without claiming they are ready", async () => {
    const manager = createManager({ probe: async () => false });
    expect(await manager.getStatus(workspace.id, null)).toEqual({
      status: "unavailable",
      message: "This workspace has no available directory.",
    });
    expect(await manager.getStatus(workspace.id, workspace.cwd)).toEqual({
      status: "unavailable",
      message: "No desktop found for this workspace.",
    });
    writeState();
    expect(await manager.getStatus(workspace.id, workspace.cwd)).toEqual({
      status: "unavailable",
      message: "Desktop service is not responding. Check the service, then retry.",
    });
  });

  it("rejects unsafe state before making an HTTP probe", async () => {
    writeState({ browser_url: "https://user:password@example.test/" });
    let probes = 0;
    const manager = createManager({
      probe: async () => {
        probes += 1;
        return true;
      },
    });
    expect(await manager.getStatus(workspace.id, workspace.cwd)).toEqual({
      status: "error",
      message: "Desktop URL contains embedded credentials, which is prohibited.",
    });
    expect(probes).toBe(0);
  });
});
