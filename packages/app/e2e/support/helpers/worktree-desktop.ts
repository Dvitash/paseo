import http from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, type Page } from "@playwright/test";
import { copyPluginExample } from "./plugin-fixture";
import { openCommandCenter } from "./command-center";
import type { connectNewWorkspaceDaemonClient } from "./new-workspace";

export const WORKTREE_DESKTOP_PLUGIN_ID = "spark-worktree-desktop";
export const DESKTOP_TAB_TEST_ID =
  "workspace-tab-plugin_workspace_22_spark-worktree-desktop_7_desktop";
export const DESKTOP_CLOSE_TEST_ID = `workspace-plugin-close-${Buffer.from(
  "plugin_workspace_22_spark-worktree-desktop_7_desktop",
).toString("base64url")}`;

export type WorktreeDesktopDaemonClient = Awaited<
  ReturnType<typeof connectNewWorkspaceDaemonClient>
>;

const FIXTURE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Worktree Desktop Session</title>
  <style>
    body { font-family: sans-serif; padding: 20px; background: #18181b; color: #f4f4f5; }
    h1 { color: #10b981; font-size: 20px; }
    input { padding: 6px 10px; font-size: 14px; background: #27272a; color: #f4f4f5; border: 1px solid #3f3f46; border-radius: 4px; }
    button { padding: 6px 12px; font-size: 14px; background: #10b981; color: #09090b; border: none; border-radius: 4px; cursor: pointer; }
    #desktop-output { margin-top: 12px; font-family: monospace; color: #38bdf8; }
  </style>
</head>
<body>
  <h1 data-testid="desktop-heading">Worktree Desktop Ready</h1>
  <p>Interactive Desktop Stream Fixture</p>
  <input data-testid="desktop-input" id="desktop-input" type="text" placeholder="Enter command" />
  <button data-testid="desktop-button" id="desktop-button" onclick="document.getElementById('desktop-output').textContent = document.getElementById('desktop-input').value">Run</button>
  <div data-testid="desktop-output" id="desktop-output"></div>
</body>
</html>`;

export interface DesktopHttpFixture {
  readonly port: number;
  readonly url: string;
  release200(): void;
  set503(): void;
  isReleased(): boolean;
  close(): Promise<void>;
}

/**
 * Creates a real loopback HTTP server directly on a free port in 18103..18999.
 * Retains the listening socket to avoid close/rebind race conditions.
 * Initially responds with HTTP 503 until release200() is called.
 */
export async function createDesktopHttpServer(
  startPort = 18103,
  endPort = 18999,
): Promise<DesktopHttpFixture> {
  let released = false;

  const server = http.createServer((_req, res) => {
    if (!released) {
      res.statusCode = 503;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("503 Service Unavailable: desktop initializing");
      return;
    }

    res.statusCode = 200;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Content-Length", Buffer.byteLength(FIXTURE_HTML));
    res.end(FIXTURE_HTML);
  });

  const { promise, resolve, reject } = Promise.withResolvers<number>();
  let currentPort = startPort;

  function tryBind() {
    if (currentPort > endPort) {
      reject(new Error(`No free port found in range ${startPort}..${endPort}`));
      return;
    }
    const port = currentPort;
    currentPort += 1;

    const errorHandler = (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE" || err.code === "EACCES") {
        server.removeListener("listening", listeningHandler);
        tryBind();
      } else {
        reject(err);
      }
    };

    const listeningHandler = () => {
      server.removeListener("error", errorHandler);
      resolve(port);
    };

    server.once("error", errorHandler);
    server.once("listening", listeningHandler);
    server.listen(port, "127.0.0.1");
  }

  tryBind();
  const boundPort = await promise;

  return {
    port: boundPort,
    url: `http://127.0.0.1:${boundPort}/`,
    release200() {
      released = true;
    },
    set503() {
      released = false;
    },
    isReleased() {
      return released;
    },
    close() {
      const { promise: closePromise, resolve: resolveClose } = Promise.withResolvers<void>();
      server.close(() => resolveClose());
      return closePromise;
    },
  };
}

export interface WorktreeDesktopPluginSetup {
  directory: string;
  baseDir: string;
  port: number;
  display: number;
  fixtureUrl: string;
  release200(): void;
  set503(): void;
  cleanup(): Promise<void>;
}

export interface WorktreeDesktopPluginOptions {
  startupTimeoutMs?: number;
  pollIntervalMs?: number;
}

/**
 * Clones plugin-examples/worktree-desktop with test requirements,
 * binds a real loopback HTTP server on an available port in 18103..18999,
 * and replaces ONLY root index.server.ts with a thin adapter injecting
 * an execFile implementation that executes process.execPath [fixtureScript,...actual args]
 * with a dedicated temp baseDir.
 */
export async function setupWorktreeDesktopPlugin(
  options: WorktreeDesktopPluginOptions = {},
): Promise<WorktreeDesktopPluginSetup> {
  const startupTimeoutMs = options.startupTimeoutMs ?? 6000;
  const pollIntervalMs = options.pollIntervalMs ?? 200;

  let httpFixture: DesktopHttpFixture | undefined;
  let baseDir: string | undefined;
  let pluginCleanup: (() => Promise<void>) | undefined;

  try {
    httpFixture = await createDesktopHttpServer(18103, 18999);
    baseDir = await mkdtemp(path.join(tmpdir(), "paseo-desktop-base-"));
    const copyResult = await copyPluginExample("worktree-desktop");
    pluginCleanup = copyResult.cleanup;
    const directory = copyResult.directory;

    const port = httpFixture.port;
    const display = port - 18000;

    const fixtureScriptPath = path.join(directory, "fixture-cli.mjs");
    const fixtureScriptContent = `import fs from "node:fs";
import path from "node:path";

const baseDir = ${JSON.stringify(baseDir)};
const port = ${port};
const display = ${display};

const args = process.argv.slice(2);
const command = args[0];

if (command === "start") {
  const worktreeIdx = args.indexOf("--worktree");
  const cwd = worktreeIdx !== -1 ? args[worktreeIdx + 1] : process.cwd();
  const name = args[1] && !args[1].startsWith("--") ? args[1] : "";
  const slug = name || path.basename(cwd);

  const desktopDir = path.join(baseDir, slug);
  fs.mkdirSync(desktopDir, { recursive: true });

  const state = {
    display,
    port,
    slug,
    browser_enabled: true,
    browser_url: "http://127.0.0.1:" + port + "/",
    worktree_path: cwd,
  };

  fs.writeFileSync(path.join(desktopDir, "state.json"), JSON.stringify(state, null, 2));
  process.exit(0);
}

if (command === "destroy") {
  const worktreeIdx = args.indexOf("--worktree");
  const cwd = worktreeIdx !== -1 ? args[worktreeIdx + 1] : process.cwd();

  if (fs.existsSync(baseDir)) {
    const entries = fs.readdirSync(baseDir, { withFileTypes: true });
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const stateFile = path.join(baseDir, ent.name, "state.json");
      if (fs.existsSync(stateFile)) {
        try {
          const content = JSON.parse(fs.readFileSync(stateFile, "utf8"));
          if (content.worktree_path === cwd) {
            fs.rmSync(path.join(baseDir, ent.name), { recursive: true, force: true });
          }
        } catch {}
      }
    }
  }
  process.exit(0);
}

process.exit(0);
`;

    await writeFile(fixtureScriptPath, fixtureScriptContent, "utf8");

    const serverAdapterContent = `import type { PluginCleanup } from "@getpaseo/plugin";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { execFile } from "node:child_process";
import { registerDesktopPlugin } from "./server/plugin";

export default function contribute(server: PluginServerContext): PluginCleanup {
  return registerDesktopPlugin(server, {
    baseDir: ${JSON.stringify(baseDir)},
    startupTimeoutMs: ${startupTimeoutMs},
    pollIntervalMs: ${pollIntervalMs},
    execFile: (_file, args, callback) => {
      execFile(
        process.execPath,
        [${JSON.stringify(fixtureScriptPath)}, ...args],
        (error, stdout, stderr) => {
          callback(error, stdout, stderr);
        },
      );
    },
  });
}
`;

    await writeFile(path.join(directory, "index.server.ts"), serverAdapterContent, "utf8");

    const boundHttpFixture = httpFixture;
    const boundBaseDir = baseDir;

    return {
      directory,
      baseDir: boundBaseDir,
      port,
      display,
      fixtureUrl: boundHttpFixture.url,
      release200() {
        boundHttpFixture.release200();
      },
      set503() {
        boundHttpFixture.set503();
      },
      async cleanup() {
        await boundHttpFixture.close().catch(() => undefined);
        await rm(boundBaseDir, { recursive: true, force: true }).catch(() => undefined);
        await pluginCleanup?.().catch(() => undefined);
      },
    };
  } catch (error) {
    if (httpFixture) await httpFixture.close().catch(() => undefined);
    if (baseDir) await rm(baseDir, { recursive: true, force: true }).catch(() => undefined);
    if (pluginCleanup) await pluginCleanup().catch(() => undefined);
    throw error;
  }
}

export interface DesktopEventsObserver {
  readonly pollCount: number;
  waitForPolls(targetCount: number, timeoutMs?: number): Promise<void>;
}

/**
 * Observes outgoing WebSocket frames from the page to track desktop.events RPC polls.
 */
export function observeDesktopEvents(page: Page): DesktopEventsObserver {
  let polls = 0;

  page.on("websocket", (socket) => {
    socket.on("framesent", ({ payload }) => {
      if (typeof payload !== "string") return;
      try {
        const envelope = JSON.parse(payload) as {
          type?: unknown;
          message?: { type?: unknown; method?: unknown };
          method?: unknown;
        };
        const message =
          envelope.type === "session" && envelope.message ? envelope.message : envelope;
        if (message.type === "plugin.rpc.invoke.request" && message.method === "desktop.events") {
          polls += 1;
        }
      } catch {
        // Ignore non-JSON frame payloads
      }
    });
  });

  return {
    get pollCount() {
      return polls;
    },
    async waitForPolls(targetCount: number, timeoutMs = 30_000) {
      await expect.poll(() => polls, { timeout: timeoutMs }).toBeGreaterThanOrEqual(targetCount);
    },
  };
}

/**
 * Runs a command from the Command Center.
 */
export async function runDesktopCommand(page: Page, title = "Open desktop"): Promise<void> {
  const panel = await openCommandCenter(page);
  await panel.getByTestId("command-center-input").fill(title);
  const actionButton = panel.getByRole("button", { name: title, exact: true });
  await expect(actionButton).toBeVisible({ timeout: 15_000 });
  await actionButton.click();
  await expect(panel).not.toBeVisible({ timeout: 10_000 });
}

/**
 * Closes the active Desktop workspace tab by hovering and clicking the close button.
 */
export async function closeDesktopTab(page: Page): Promise<void> {
  const desktopTab = page.getByTestId(DESKTOP_TAB_TEST_ID).filter({ visible: true }).first();
  await expect(desktopTab).toBeVisible({ timeout: 15_000 });

  await desktopTab.hover();
  const closeButton = page.getByTestId(DESKTOP_CLOSE_TEST_ID).filter({ visible: true }).first();
  await expect(closeButton).toBeVisible();
  await closeButton.click();

  await expect(page.getByTestId(DESKTOP_TAB_TEST_ID)).toHaveCount(0);
}
