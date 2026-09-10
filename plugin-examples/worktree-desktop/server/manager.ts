import type { PluginHookWorkspace, PluginSessionOpenRequest } from "@getpaseo/plugin/server";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { validateDesktopUrl, type DesktopEventsCursor, type DesktopStatus } from "../shared/rpc";
import { DesktopEventQueue } from "./events";
import { probeDesktopReadiness } from "./probe";
import { DEFAULT_BASE_DIR, findDesktopStateForCwd, findDesktopStateSummary } from "./state";

export interface DesktopManagerOptions {
  baseDir?: string;
  cliPath?: string;
  xauthority?: string;
  execFile?: (
    file: string,
    args: string[],
    callback: (error: Error | null, stdout: string, stderr: string) => void,
  ) => void;
  probe?: (display: number, browserUrl: string) => Promise<boolean>;
  now?: () => number;
  schedule?: (callback: () => void, delayMs: number) => () => void;
  generation?: string;
  startupTimeoutMs?: number;
  pollIntervalMs?: number;
  isWorktreePath?: (cwd: string) => boolean;
}

interface DesktopLaunch {
  workspaceId: string;
  cwd: string;
  deadline: number;
  outcome: { status: "starting" } | { status: "started" } | { status: "error"; message: string };
}

function schedule(callback: () => void, delayMs: number): () => void {
  const timer = setTimeout(callback, delayMs);
  return () => clearTimeout(timer);
}

export class DesktopManager {
  private readonly baseDir: string;
  private readonly cliPath: string;
  private readonly xauthority: string;
  private readonly run: NonNullable<DesktopManagerOptions["execFile"]>;
  private readonly probe: NonNullable<DesktopManagerOptions["probe"]>;
  private readonly now: () => number;
  private readonly schedule: NonNullable<DesktopManagerOptions["schedule"]>;
  private readonly startupTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly isWorktreePath: (cwd: string) => boolean;
  private readonly events: DesktopEventQueue;
  private readonly launches = new Map<string, DesktopLaunch>();
  private readonly polls = new Map<string, () => void>();
  private disposed = false;

  constructor(options: DesktopManagerOptions = {}) {
    this.baseDir = options.baseDir ?? DEFAULT_BASE_DIR;
    this.cliPath =
      options.cliPath ??
      process.env.SPARK_WORKTREE_DESKTOP_CLI ??
      join(homedir(), ".local/bin/spark-worktree-desktop");
    this.xauthority =
      options.xauthority ??
      process.env.XAUTHORITY ??
      join(homedir(), ".config/spark-desktop/Xauthority");
    this.run = options.execFile ?? execFile;
    this.probe = options.probe ?? probeDesktopReadiness;
    this.now = options.now ?? Date.now;
    this.schedule = options.schedule ?? schedule;
    this.startupTimeoutMs = options.startupTimeoutMs ?? 120_000;
    this.pollIntervalMs = options.pollIntervalMs ?? 500;
    this.isWorktreePath =
      options.isWorktreePath ??
      ((cwd) => cwd.includes(".paseo/worktrees") || existsSync(join(cwd, ".git")));
    this.events = new DesktopEventQueue(options.generation);
  }

  dispose(): void {
    this.disposed = true;
    for (const cancel of this.polls.values()) cancel();
    this.polls.clear();
    this.launches.clear();
  }

  pollEvents(cursor: DesktopEventsCursor | null) {
    const result = this.events.poll(cursor);
    return { ...result, workspaceIds: result.workspaceIds.filter((id) => this.launches.has(id)) };
  }

  private isPending(launch: DesktopLaunch): boolean {
    return (
      !this.disposed &&
      this.launches.get(launch.workspaceId) === launch &&
      launch.outcome.status === "starting"
    );
  }

  private finish(launch: DesktopLaunch, outcome: DesktopLaunch["outcome"]): void {
    if (!this.isPending(launch)) return;
    launch.outcome = outcome;
    this.polls.get(launch.workspaceId)?.();
    this.polls.delete(launch.workspaceId);
    this.events.publish(launch.workspaceId);
  }

  onWorkspaceCreated({ workspace }: { workspace: PluginHookWorkspace }): void {
    if (this.disposed || this.launches.has(workspace.id)) return;
    if (!workspace.cwd || !this.isWorktreePath(workspace.cwd)) return;

    const launch: DesktopLaunch = {
      workspaceId: workspace.id,
      cwd: workspace.cwd,
      deadline: this.now() + this.startupTimeoutMs,
      outcome: { status: "starting" },
    };
    this.launches.set(workspace.id, launch);
    const args = ["start"];
    if (workspace.name) args.push(workspace.name);
    args.push("--worktree", workspace.cwd);

    try {
      this.run(this.cliPath, args, (error) => {
        if (error) this.finish(launch, { status: "error", message: error.message });
      });
    } catch (error) {
      this.finish(launch, {
        status: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
    // Observe readiness even if the launcher hangs after starting the stream.
    void this.poll(launch);
  }

  private async poll(launch: DesktopLaunch): Promise<void> {
    if (!this.isPending(launch)) return;
    if (this.now() >= launch.deadline) {
      this.finish(launch, {
        status: "error",
        message:
          "Desktop stream did not become ready before the startup timeout. Retry after checking the desktop service.",
      });
      return;
    }

    try {
      const status = await this.inspect(launch.cwd);
      if (!this.isPending(launch)) return;
      if (status.status === "ready") {
        this.finish(launch, { status: "started" });
        return;
      }
      if (status.status === "error") {
        this.finish(launch, status);
        return;
      }
      const cancel = this.schedule(() => {
        this.polls.delete(launch.workspaceId);
        void this.poll(launch);
      }, this.pollIntervalMs);
      this.polls.set(launch.workspaceId, cancel);
    } catch (error) {
      this.finish(launch, {
        status: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  onWorkspaceArchived({ workspace }: { workspace: PluginHookWorkspace }): void {
    if (this.disposed) return;
    this.launches.delete(workspace.id);
    this.polls.get(workspace.id)?.();
    this.polls.delete(workspace.id);
    if (!workspace.cwd) return;
    this.run(this.cliPath, ["destroy", "--worktree", workspace.cwd], (error) => {
      if (error)
        console.error("[spark-worktree-desktop-plugin] Desktop cleanup failed:", error.message);
    });
  }

  onAgentSessionOpen(request: PluginSessionOpenRequest): PluginSessionOpenRequest {
    const state = findDesktopStateSummary(request.cwd, this.baseDir);
    if (!state) return request;
    return {
      ...request,
      env: {
        ...request.env,
        DISPLAY: `:${state.display}`,
        XAUTHORITY: this.xauthority,
        SPARK_WORKTREE_SLUG: state.slug,
        SPARK_WORKTREE_PORT: String(state.port),
      },
    };
  }

  async getStatus(workspaceId: string, cwd: string | null): Promise<DesktopStatus> {
    if (!cwd)
      return { status: "unavailable", message: "This workspace has no available directory." };
    const status = await this.inspect(cwd);
    // Retry rechecks the actual endpoint, so late startup can recover without another launch.
    if (status.status === "ready" || status.status === "error") return status;
    const launch = this.launches.get(workspaceId);
    if (launch?.outcome.status === "error") {
      return { status: "error", message: `Desktop start failed: ${launch.outcome.message}` };
    }
    if (launch?.outcome.status === "starting") return { status: "starting" };
    return status;
  }

  private async inspect(cwd: string): Promise<DesktopStatus> {
    const result = findDesktopStateForCwd(cwd, this.baseDir);
    if (result.kind === "not_found")
      return { status: "unavailable", message: "No desktop found for this workspace." };
    if (result.kind !== "found") return { status: "error", message: result.message };
    const state = result.state;
    if (!state.browserEnabled)
      return {
        status: "unavailable",
        message: "Browser desktop streaming is not enabled for this worktree.",
      };
    if (!state.browserUrl)
      return { status: "unavailable", message: "The desktop has not published a browser URL yet." };
    const checked = validateDesktopUrl(state.browserUrl);
    if (!checked.ok) return { status: "error", message: checked.message };
    const ready = await this.probe(state.display, checked.url);
    if (!ready)
      return {
        status: "unavailable",
        message: "Desktop service is not responding. Check the service, then retry.",
      };
    return { status: "ready", url: checked.url };
  }
}
