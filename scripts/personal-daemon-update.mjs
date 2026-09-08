import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isMainModule } from "./is-main-module.mjs";
import { verifyDaemonArtifacts } from "./personal-artifacts.mjs";

export const SAFE_AGENT_STATUSES = new Set(["idle", "closed", "error"]);
export const SERVER_WEB_INDEX_RELPATH =
  "node_modules/@getpaseo/server/dist/server/web-ui/index.html";
export const CLI_DIST_RELPATH = "node_modules/@getpaseo/cli/dist/index.js";
export const RELEASE_COMPLETE_FILENAME = ".release-complete.json";
export const DROPIN_FILENAME = "90-personal-release.conf";
export const DEFAULT_RESTART_TIMEOUT_MS = 120000;

export function defaultRunCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
    timeout: 30000,
    ...options,
  });
  const timedOut = result.error && result.error.code === "ETIMEDOUT";
  return {
    status: result.status ?? (timedOut ? 124 : 1),
    stdout: result.stdout || "",
    stderr: result.stderr || (result.error ? result.error.message : ""),
    error: result.error,
  };
}

export function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function validateConfig(config) {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error("Config must be a non-null object");
  }

  const requiredStringKeys = [
    "repository",
    "workflow",
    "owner",
    "installedAt",
    "root",
    "paseoHome",
    "service",
    "nodePath",
    "npmPath",
    "ghPath",
    "systemctlPath",
    "currentCli",
    "systemdUserDir",
  ];

  for (const key of requiredStringKeys) {
    if (typeof config[key] !== "string" || !config[key].trim()) {
      throw new Error(`Missing or empty required config key: ${key}`);
    }
    if (/[\r\n]/.test(config[key]) || config[key].includes("\0")) {
      throw new Error(`Config key '${key}' contains forbidden control characters or newlines`);
    }
  }

  if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(config.repository)) {
    throw new Error(`Invalid repository format: ${config.repository}`);
  }

  const dateVal = new Date(config.installedAt);
  if (Number.isNaN(dateVal.getTime())) {
    throw new Error(`Invalid installedAt timestamp: ${config.installedAt}`);
  }

  if (
    !/^[a-zA-Z0-9_.-]+\.service$/.test(config.service) ||
    config.service.includes("/") ||
    config.service.includes("\\") ||
    path.basename(config.service) !== config.service
  ) {
    throw new Error(
      `Invalid service name: must be a safe .service basename without path traversal (${config.service})`,
    );
  }

  const absPathKeys = [
    "root",
    "paseoHome",
    "nodePath",
    "npmPath",
    "ghPath",
    "systemctlPath",
    "currentCli",
    "systemdUserDir",
  ];

  for (const key of absPathKeys) {
    if (!path.isAbsolute(config[key])) {
      throw new Error(`Config path for ${key} must be absolute: ${config[key]}`);
    }
  }

  return { ...config };
}

export function loadConfig(configPath) {
  const resolved = path.resolve(configPath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Config file does not exist: ${resolved}`);
  }
  const raw = fs.readFileSync(resolved, "utf8");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Failed to parse config file JSON: ${err.message}`, { cause: err });
  }
  return validateConfig(parsed);
}

export function checkExecutable(execPath, name = "executable") {
  if (!fs.existsSync(execPath)) {
    throw new Error(`${name} does not exist: ${execPath}`);
  }
  try {
    fs.accessSync(execPath, fs.constants.X_OK);
  } catch {
    throw new Error(`${name} is not executable: ${execPath}`);
  }
}

export function checkServiceEligibility({
  systemctlPath,
  service,
  runCommand = defaultRunCommand,
}) {
  const result = runCommand(systemctlPath, ["--user", "is-active", "--quiet", service]);
  if (result.status !== 0) {
    throw new Error(`Systemd user service is not active: ${service}`);
  }
  return true;
}

export function checkSideChatsDirectory(paseoHome) {
  const sideChatsDir = path.join(paseoHome, "side-chats");
  if (!fs.existsSync(sideChatsDir)) {
    return { safe: true };
  }

  let entries;
  try {
    entries = fs.readdirSync(sideChatsDir, { withFileTypes: true });
  } catch (err) {
    throw new Error(`Failed to read side-chats directory: ${err.message}`, { cause: err });
  }

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const filePath = path.join(sideChatsDir, entry.name);
    let record;
    try {
      const content = fs.readFileSync(filePath, "utf8");
      record = JSON.parse(content);
    } catch (err) {
      throw new Error(`Failed to parse side-chat record ${entry.name}: ${err.message}`, {
        cause: err,
      });
    }

    if (!record || typeof record !== "object" || typeof record.status !== "string") {
      throw new Error(`Side-chat record ${entry.name} missing string status`);
    }

    if (record.status === "running") {
      return {
        safe: false,
        reason: `Side-chat record ${record.mainAgentId || entry.name} is running`,
      };
    }

    if (!SAFE_AGENT_STATUSES.has(record.status) && record.status !== "archived") {
      throw new Error(`Unknown side-chat status: ${record.status} in ${entry.name}`);
    }
  }

  return { safe: true };
}

export function parseAgentListOutput(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch (err) {
    throw new Error(`Invalid JSON from agent ls: ${err.message}`, { cause: err });
  }
  if (
    parsed &&
    typeof parsed === "object" &&
    !Array.isArray(parsed) &&
    Array.isArray(parsed.data)
  ) {
    parsed = parsed.data;
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`Expected array of agents from agent ls, got: ${typeof parsed}`);
  }
  return parsed;
}

export function parseDaemonStatusOutput(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch (err) {
    throw new Error(`Invalid JSON from daemon status: ${err.message}`, { cause: err });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Expected JSON object from daemon status, got: ${typeof parsed}`);
  }

  return {
    localDaemon: parsed.localDaemon ?? null,
    connectedDaemon: parsed.connectedDaemon ?? null,
    daemonVersion: parsed.daemonVersion ?? null,
  };
}

export function checkAgentStatus({ currentCli, paseoHome, runCommand = defaultRunCommand }) {
  const args = ["ls", "-a", "-g", "--json"];
  const env = { ...process.env, PASEO_HOME: paseoHome };
  delete env.PASEO_HOST;
  delete env.PASEO_LISTEN;
  const result = runCommand(currentCli, args, { env, timeout: 15000 });

  if (result.status !== 0) {
    throw new Error(
      `CLI agent ls command failed (exit ${result.status}): ${result.stderr || result.stdout}`,
    );
  }

  const agents = parseAgentListOutput(result.stdout);

  for (const agent of agents) {
    if (!agent || typeof agent !== "object") {
      throw new Error("Invalid agent item in agent list: expected object");
    }
    if (typeof agent.status !== "string") {
      throw new Error(`Agent ${agent.shortId || agent.name || "unknown"} missing string status`);
    }
    if (agent.status === "running") {
      return {
        safe: false,
        reason: `Agent ${agent.shortId || agent.name || "unknown"} is running`,
      };
    }
    if (!SAFE_AGENT_STATUSES.has(agent.status)) {
      throw new Error(
        `Unknown agent status '${agent.status}' for agent ${agent.shortId || agent.name || "unknown"}`,
      );
    }
  }

  const sideChatsCheck = checkSideChatsDirectory(paseoHome);
  if (!sideChatsCheck.safe) {
    return sideChatsCheck;
  }

  return { safe: true };
}

export async function verifyIdleForUpdate({
  currentCli,
  paseoHome,
  runCommand = defaultRunCommand,
  sleep = defaultSleep,
  intervalMs = 5000,
}) {
  const check1 = checkAgentStatus({ currentCli, paseoHome, runCommand });
  if (!check1.safe) {
    return check1;
  }

  await sleep(intervalMs);

  const check2 = checkAgentStatus({ currentCli, paseoHome, runCommand });
  if (!check2.safe) {
    return check2;
  }

  return { safe: true };
}

export function readStatusFile(root) {
  const statusPath = path.join(root, "status.json");
  if (!fs.existsSync(statusPath)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(statusPath, "utf8"));
  } catch {
    return null;
  }
}

export function writeStatusFile(root, statusData) {
  const statusPath = path.join(root, "status.json");
  fs.mkdirSync(root, { recursive: true });
  const tmpPath = path.join(root, `.status.json.tmp-${Date.now()}`);
  fs.writeFileSync(tmpPath, JSON.stringify(statusData, null, 2), "utf8");
  fs.renameSync(tmpPath, statusPath);
}

export function readLedgerFile(root) {
  const ledgerPath = path.join(root, "ledger.json");
  if (!fs.existsSync(ledgerPath)) {
    return null;
  }
  const ledger = JSON.parse(fs.readFileSync(ledgerPath, "utf8"));
  if (
    !Number.isSafeInteger(ledger?.lastHandledRunId) ||
    ledger.lastHandledRunId < 1 ||
    !["success", "error"].includes(ledger.lastHandledState)
  ) {
    throw new Error("Invalid updater ledger; refusing to replay requests");
  }
  return ledger;
}

export function writeLedgerFile(root, ledgerData) {
  const ledgerPath = path.join(root, "ledger.json");
  fs.mkdirSync(root, { recursive: true });
  const tmpPath = path.join(root, `.ledger.json.tmp-${Date.now()}`);
  fs.writeFileSync(tmpPath, JSON.stringify(ledgerData, null, 2), "utf8");
  fs.renameSync(tmpPath, ledgerPath);
}

export function emitCommitStatus({
  ghPath,
  repository,
  headSha,
  state,
  description,
  runId,
  runCommand = defaultRunCommand,
}) {
  const hostname = os.hostname();
  const context = `personal-daemon/${hostname}`;
  const targetUrl = `https://github.com/${repository}/actions/runs/${runId}`;
  try {
    const args = [
      "api",
      `repos/${repository}/statuses/${headSha}`,
      "--method",
      "POST",
      "-f",
      `state=${state}`,
      "-f",
      `context=${context}`,
      "-f",
      `description=${description.slice(0, 140)}`,
      "-f",
      `target_url=${targetUrl}`,
    ];
    const result = runCommand(ghPath, args);
    if (result.status !== 0) {
      throw new Error(result.stderr || result.stdout || `gh exited ${result.status}`);
    }
  } catch (err) {
    // Best effort, do not crash
    console.warn(`[personal-daemon-update] Failed to emit commit status: ${err.message}`);
  }
}

function newestSuccessfulRequest(runs, installedAt) {
  if (!Array.isArray(runs)) throw new Error("Expected GitHub workflow run array");
  const installedTime = Date.parse(installedAt);
  return runs
    .filter(
      (run) =>
        run.status === "completed" &&
        run.conclusion === "success" &&
        run.event === "workflow_dispatch" &&
        Number.isSafeInteger(run.databaseId) &&
        Date.parse(run.createdAt) > installedTime,
    )
    .sort(
      (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.databaseId - a.databaseId,
    )[0];
}

function trustedRunDetails(details, newest, config) {
  if (!details || typeof details !== "object") return false;
  const expectedRepo = config.repository.toLowerCase();
  if (details.repository?.full_name?.toLowerCase() !== expectedRepo) return false;
  if (details.head_repository && details.head_repository.full_name?.toLowerCase() !== expectedRepo)
    return false;
  if (details.actor?.login?.toLowerCase() !== config.owner.toLowerCase()) return false;
  if (details.head_sha !== newest.headSha || !/^[0-9a-f]{40}$/i.test(details.head_sha))
    return false;
  if (Date.parse(details.created_at) !== Date.parse(newest.createdAt)) return false;
  return (
    details.status === "completed" &&
    details.conclusion === "success" &&
    details.event === "workflow_dispatch" &&
    details.head_branch === "main" &&
    details.path === `.github/workflows/${config.workflow}`
  );
}

export function alreadyHandledRequest(root, newest) {
  const ledger = readLedgerFile(root);
  if (ledger && Number(ledger.lastHandledRunId) >= newest.databaseId) return true;
  const status = readStatusFile(root);
  return Boolean(
    status &&
    ["success", "error"].includes(status.state) &&
    Number(status.runId) >= newest.databaseId,
  );
}

export function fetchEligibleWorkflowRun({
  ghPath,
  repository,
  workflow,
  owner,
  installedAt,
  root,
  runCommand = defaultRunCommand,
}) {
  const listRes = runCommand(ghPath, [
    "run",
    "list",
    "--repo",
    repository,
    "--workflow",
    workflow,
    "--branch",
    "main",
    "--event",
    "workflow_dispatch",
    "--status",
    "success",
    "--json",
    "databaseId,headSha,createdAt,conclusion,status,event,workflowDatabaseId,workflowName,url",
    "-L",
    "10",
  ]);
  if (listRes.status !== 0)
    throw new Error(`Failed to list workflow runs: ${listRes.stderr || listRes.stdout}`);
  const newest = newestSuccessfulRequest(JSON.parse(listRes.stdout), installedAt);
  // Never fall back to an older request after the newest request has been handled.
  if (!newest || alreadyHandledRequest(root, newest)) return null;
  const apiRes = runCommand(ghPath, [
    "api",
    `repos/${repository}/actions/runs/${newest.databaseId}`,
  ]);
  if (apiRes.status !== 0)
    throw new Error(`Failed to inspect workflow run: ${apiRes.stderr || apiRes.stdout}`);
  if (!trustedRunDetails(JSON.parse(apiRes.stdout), newest, { repository, workflow, owner }))
    return null;
  return {
    runId: newest.databaseId,
    headSha: newest.headSha,
    createdAt: newest.createdAt,
    run: newest,
  };
}

export function downloadArtifactBundle({
  ghPath,
  repository,
  runId,
  headSha,
  targetDir,
  runCommand = defaultRunCommand,
}) {
  const artifactName = `paseo-daemon-${headSha}`;
  if (fs.existsSync(targetDir)) {
    try {
      return verifyDaemonArtifacts(targetDir, { expectedCommit: headSha });
    } catch {
      // Retry incomplete downloads in a fresh directory; gh refuses existing files.
      fs.rmSync(targetDir, { recursive: true, force: true });
    }
  }
  fs.mkdirSync(targetDir, { recursive: true });

  const downloadRes = runCommand(
    ghPath,
    [
      "run",
      "download",
      String(runId),
      "--repo",
      repository,
      "--name",
      artifactName,
      "--dir",
      targetDir,
    ],
    { timeout: 300000 },
  );

  if (downloadRes.status !== 0) {
    throw new Error(
      `Failed to download artifact bundle ${artifactName}: ${downloadRes.stderr || downloadRes.stdout}`,
    );
  }

  return verifyDaemonArtifacts(targetDir, { expectedCommit: headSha });
}

export function verifyCompletedStage(stageDir, manifest, nodePath, runCommand = defaultRunCommand) {
  const markerPath = path.join(stageDir, RELEASE_COMPLETE_FILENAME);
  if (!fs.existsSync(markerPath)) {
    return false;
  }

  let marker;
  try {
    marker = JSON.parse(fs.readFileSync(markerPath, "utf8"));
  } catch {
    return false;
  }

  if (marker.commit !== manifest.commit || marker.version !== manifest.version) {
    return false;
  }

  const cliPath = path.join(stageDir, CLI_DIST_RELPATH);
  if (!fs.existsSync(cliPath)) {
    return false;
  }

  const versionRes = runCommand(nodePath, [cliPath, "--version"]);
  if (versionRes.status !== 0 || versionRes.stdout.trim() !== manifest.version) {
    return false;
  }

  const webIndexPath = path.join(stageDir, SERVER_WEB_INDEX_RELPATH);
  if (!fs.existsSync(webIndexPath)) {
    return false;
  }

  return true;
}

export function stageRelease({
  root,
  headSha,
  manifest,
  artifactDir,
  npmPath,
  nodePath,
  runCommand = defaultRunCommand,
}) {
  const targetReleaseDir = path.join(root, "releases", headSha);
  fs.mkdirSync(path.join(root, "releases"), { recursive: true });

  if (fs.existsSync(targetReleaseDir)) {
    if (verifyCompletedStage(targetReleaseDir, manifest, nodePath, runCommand)) {
      return {
        releaseDir: targetReleaseDir,
        reused: true,
        version: manifest.version,
      };
    }
    throw new Error(
      `Target release directory ${targetReleaseDir} already exists but verification failed; refusing to overwrite or delete existing release directory`,
    );
  }

  const stagingDir = path.join(root, "releases", `.staging-${headSha}-${Date.now()}`);
  fs.mkdirSync(stagingDir, { recursive: true });

  try {
    const tarballPaths = manifest.packages.map((pkg) => path.join(artifactDir, pkg.file));

    const npmArgs = [
      "install",
      "--prefix",
      stagingDir,
      "--omit=dev",
      "--no-audit",
      "--no-fund",
      ...tarballPaths,
    ];

    const npmRes = runCommand(npmPath, npmArgs, {
      timeout: 20 * 60 * 1000,
      env: { ...process.env, ONNXRUNTIME_NODE_INSTALL: "skip" },
    });
    if (npmRes.status !== 0) {
      throw new Error(
        `npm install failed (exit ${npmRes.status}): ${npmRes.stderr || npmRes.stdout}`,
      );
    }

    const cliPath = path.join(stagingDir, CLI_DIST_RELPATH);
    if (!fs.existsSync(cliPath)) {
      throw new Error(`Installed CLI index not found at ${cliPath}`);
    }

    const versionRes = runCommand(nodePath, [cliPath, "--version"]);
    if (versionRes.status !== 0) {
      throw new Error(`Installed CLI --version failed: ${versionRes.stderr || versionRes.stdout}`);
    }

    const resolvedCliVersion = versionRes.stdout.trim();
    if (resolvedCliVersion !== manifest.version) {
      throw new Error(
        `Installed CLI version mismatch: expected ${manifest.version}, got ${resolvedCliVersion}`,
      );
    }

    const webIndexPath = path.join(stagingDir, SERVER_WEB_INDEX_RELPATH);
    if (!fs.existsSync(webIndexPath)) {
      throw new Error(`Bundled server web index not found at ${webIndexPath}`);
    }

    const markerData = {
      format: 1,
      commit: headSha,
      version: manifest.version,
      installedAt: new Date().toISOString(),
    };
    fs.writeFileSync(
      path.join(stagingDir, RELEASE_COMPLETE_FILENAME),
      JSON.stringify(markerData, null, 2),
      "utf8",
    );

    if (fs.existsSync(targetReleaseDir)) {
      throw new Error(
        `Target release directory ${targetReleaseDir} appeared unexpectedly; refusing to overwrite`,
      );
    }
    fs.renameSync(stagingDir, targetReleaseDir);
    return {
      releaseDir: targetReleaseDir,
      reused: false,
      version: manifest.version,
    };
  } catch (err) {
    if (fs.existsSync(stagingDir)) {
      fs.rmSync(stagingDir, { recursive: true, force: true });
    }
    throw err;
  }
}

export function quoteSystemdArg(arg) {
  let escaped = String(arg)
    .replaceAll("%", () => "%%")
    .replaceAll("$", () => "$$");
  escaped = escaped.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
  return `"${escaped}"`;
}

export function generateDropInContent({ nodePath, root, paseoHome }) {
  const cliPath = path.join(root, "current", CLI_DIST_RELPATH);
  return `[Service]\nExecStart=\nExecStart=${quoteSystemdArg(nodePath)} ${quoteSystemdArg(cliPath)} daemon start --foreground --home ${quoteSystemdArg(paseoHome)}\n`;
}
export function writeDropInAtomic(dropInPath, content) {
  const dir = path.dirname(dropInPath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = path.join(dir, `.${path.basename(dropInPath)}.tmp-${Date.now()}`);
  fs.writeFileSync(tmpPath, content, "utf8");
  fs.renameSync(tmpPath, dropInPath);
}

export function swapCurrentSymlink(root, targetReleaseDir) {
  const currentSymlink = path.join(root, "current");
  const tmpSymlink = path.join(root, `.current.tmp-${Date.now()}`);
  fs.symlinkSync(targetReleaseDir, tmpSymlink);
  fs.renameSync(tmpSymlink, currentSymlink);
}

export function probeDaemon(config, runCommand, cliPath, expectedVersion) {
  const active = runCommand(config.systemctlPath, ["--user", "is-active", config.service], {
    timeout: 5000,
  });
  if (active.status !== 0 || active.stdout.trim() !== "active")
    return { ready: false, reason: "inactive" };
  const env = { ...process.env, PASEO_HOME: config.paseoHome };
  delete env.PASEO_HOST;
  delete env.PASEO_LISTEN;
  const result = runCommand(
    config.nodePath,
    [cliPath, "daemon", "status", "--home", config.paseoHome, "--json"],
    { env, timeout: 5000 },
  );
  if (result.status !== 0) return { ready: false, reason: "active_but_status_probe_failed" };
  try {
    const status = parseDaemonStatusOutput(result.stdout);
    const ready =
      status.localDaemon === "running" &&
      status.connectedDaemon === "reachable" &&
      (expectedVersion === undefined || status.daemonVersion === expectedVersion);
    return {
      ready,
      reason: ready ? "active_and_reachable" : "active_but_unready",
      version: status.daemonVersion,
    };
  } catch {
    return { ready: false, reason: "active_but_status_unparseable" };
  }
}

async function awaitDaemon(config, options) {
  const startTime = Date.now();
  let last = { ready: false, reason: "not_probed" };
  while (Date.now() - startTime < options.maxWaitMs) {
    last = probeDaemon(config, options.runCommand, options.cliPath, options.expectedVersion);
    if (last.ready) return last;
    await options.sleep(options.pollIntervalMs);
  }
  return {
    ...last,
    error: `Daemon failed readiness checks within ${options.maxWaitMs}ms (${last.reason})`,
  };
}

export async function checkDaemonReadiness({
  config,
  manifest,
  runCommand = defaultRunCommand,
  sleep = defaultSleep,
  maxWaitMs = 90000,
  pollIntervalMs = 1000,
}) {
  return awaitDaemon(config, {
    runCommand,
    sleep,
    maxWaitMs,
    pollIntervalMs,
    cliPath: path.join(config.root, "current", CLI_DIST_RELPATH),
    expectedVersion: manifest.version,
  });
}

function readIfPresent(file, reader) {
  try {
    return reader(file);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

export function restartService(
  config,
  runCommand = defaultRunCommand,
  timeoutMs = DEFAULT_RESTART_TIMEOUT_MS,
) {
  const reload = runCommand(config.systemctlPath, ["--user", "daemon-reload"], { timeout: 15000 });
  if (reload.status !== 0)
    throw new Error(`systemctl daemon-reload failed: ${reload.stderr || reload.stdout}`);
  const restart = runCommand(config.systemctlPath, ["--user", "restart", config.service], {
    timeout: timeoutMs,
  });
  if (restart.status !== 0)
    throw new Error(`systemctl restart failed: ${restart.stderr || restart.stdout}`);
}

async function restoreRelease(config, previous, options) {
  // Restore files before restarting. A failed restoration must not launch the new release again.
  try {
    if (previous.link !== null) swapCurrentSymlink(config.root, previous.link);
    else fs.rmSync(path.join(config.root, "current"), { force: true });
    if (previous.dropIn !== null) writeDropInAtomic(previous.dropInPath, previous.dropIn);
    else fs.rmSync(previous.dropInPath, { force: true });
    restartService(
      config,
      options.runCommand,
      options.restartTimeoutMs ?? DEFAULT_RESTART_TIMEOUT_MS,
    );
    const restoredCli = path.join(config.root, "current", CLI_DIST_RELPATH);
    return awaitDaemon(config, {
      ...options,
      cliPath: fs.existsSync(restoredCli) ? restoredCli : config.currentCli,
    });
  } catch (error) {
    return { ready: false, reason: `rollback_failed: ${error.message}` };
  }
}

export async function activateRelease({
  config,
  releaseDir,
  manifest,
  runCommand = defaultRunCommand,
  sleep = defaultSleep,
  maxWaitMs = 90000,
  pollIntervalMs = 1000,
  restartTimeoutMs = DEFAULT_RESTART_TIMEOUT_MS,
}) {
  const dropInPath = path.join(config.systemdUserDir, `${config.service}.d`, DROPIN_FILENAME);
  const previous = {
    link: readIfPresent(path.join(config.root, "current"), fs.readlinkSync),
    dropIn: readIfPresent(dropInPath, fs.readFileSync),
    dropInPath,
  };
  const options = { runCommand, sleep, maxWaitMs, pollIntervalMs, restartTimeoutMs };
  try {
    swapCurrentSymlink(config.root, releaseDir);
    writeDropInAtomic(dropInPath, generateDropInContent(config));
    restartService(config, runCommand, restartTimeoutMs);
    const readiness = await checkDaemonReadiness({ config, manifest, ...options });
    if (!readiness.ready) throw new Error(readiness.error);
    return { ok: true };
  } catch (error) {
    const rollback = await restoreRelease(config, previous, options);
    const rollbackSummary = `${rollback.reason}, oldServiceReachable: ${rollback.ready}`;
    return {
      ok: false,
      oldServiceReachable: rollback.ready,
      rollbackSummary,
      error: `Activation failed: ${error.message}. Rollback status: ${rollbackSummary}`,
    };
  }
}

function acknowledgeActiveRelease({ config, headSha, runId, runCommand }) {
  const link = readIfPresent(path.join(config.root, "current"), fs.readlinkSync);
  if (!link || path.basename(link) !== headSha) return null;
  emitCommitStatus({
    ghPath: config.ghPath,
    repository: config.repository,
    headSha,
    runId,
    state: "pending",
    description: `Verifying active personal daemon health for run ${runId}`,
    runCommand,
  });
  const cliPath = path.join(config.root, "current", CLI_DIST_RELPATH);
  const markerPath = path.join(config.root, "current", RELEASE_COMPLETE_FILENAME);
  const marker = JSON.parse(fs.readFileSync(markerPath, "utf8"));
  if (marker.commit !== headSha || typeof marker.version !== "string") {
    throw new Error("Active release marker does not match the requested commit");
  }
  const health = probeDaemon(config, runCommand, cliPath, marker.version);
  if (!health.ready) return null;
  const version = health.version;
  writeStatusFile(config.root, {
    state: "success",
    runId,
    commit: headSha,
    version,
    message: `Personal daemon already active and verified healthy at ${headSha}`,
    updatedAt: new Date().toISOString(),
  });
  writeLedgerFile(config.root, {
    lastHandledRunId: runId,
    lastHandledSha: headSha,
    lastHandledState: "success",
    version,
    updatedAt: new Date().toISOString(),
  });
  emitCommitStatus({
    ghPath: config.ghPath,
    repository: config.repository,
    headSha,
    runId,
    state: "success",
    description: `Personal daemon is already active and healthy at ${headSha}`,
    runCommand,
  });
  return { status: "success", runId, commit: headSha, version, alreadyActive: true };
}

function recordNoPendingRun(root) {
  const prevStatus = readStatusFile(root);
  const ledger = readLedgerFile(root);
  const preserveError = ledger?.lastHandledState === "error" || prevStatus?.state === "error";
  const state = preserveError ? "error" : prevStatus?.state || "waiting";
  const message = "No eligible new workflow runs found";
  writeStatusFile(root, {
    ...prevStatus,
    state,
    message,
    lastCheckedAt: new Date().toISOString(),
  });
  return { status: state, message };
}

export async function runDaemonUpdate({
  configPath,
  checkOnly = false,
  runCommand = defaultRunCommand,
  sleep = defaultSleep,
  restartTimeoutMs = DEFAULT_RESTART_TIMEOUT_MS,
}) {
  const config = loadConfig(configPath);

  checkExecutable(config.nodePath, "nodePath");
  checkExecutable(config.npmPath, "npmPath");
  checkExecutable(config.ghPath, "ghPath");
  checkExecutable(config.systemctlPath, "systemctlPath");
  checkExecutable(config.currentCli, "currentCli");
  checkServiceEligibility({
    systemctlPath: config.systemctlPath,
    service: config.service,
    runCommand,
  });

  const idleStatus = checkAgentStatus({
    currentCli: config.currentCli,
    paseoHome: config.paseoHome,
    runCommand,
  });

  const eligibleRun = fetchEligibleWorkflowRun({
    ghPath: config.ghPath,
    repository: config.repository,
    workflow: config.workflow,
    owner: config.owner,
    installedAt: config.installedAt,
    root: config.root,
    runCommand,
  });

  if (checkOnly) {
    return {
      eligible: true,
      idle: idleStatus.safe,
      idleReason: idleStatus.reason || null,
      pendingRun: eligibleRun
        ? {
            runId: eligibleRun.runId,
            commit: eligibleRun.headSha,
            createdAt: eligibleRun.createdAt,
          }
        : null,
    };
  }

  if (!eligibleRun) return recordNoPendingRun(config.root);

  const { headSha, runId } = eligibleRun;

  const activeResult = acknowledgeActiveRelease({ config, headSha, runId, runCommand });
  if (activeResult) return activeResult;

  emitCommitStatus({
    ghPath: config.ghPath,
    repository: config.repository,
    headSha,
    runId,
    state: "pending",
    description: "Starting personal daemon staging and validation",
    runCommand,
  });

  const downloadDir = path.join(config.root, "downloads", headSha);
  let manifest;
  try {
    manifest = downloadArtifactBundle({
      ghPath: config.ghPath,
      repository: config.repository,
      runId,
      headSha,
      targetDir: downloadDir,
      runCommand,
    });
  } catch (downloadErr) {
    writeStatusFile(config.root, {
      state: "error",
      runId,
      commit: headSha,
      error: downloadErr.message,
      updatedAt: new Date().toISOString(),
    });
    writeLedgerFile(config.root, {
      lastHandledRunId: runId,
      lastHandledSha: headSha,
      lastHandledState: "error",
      lastHandledError: downloadErr.message,
      updatedAt: new Date().toISOString(),
    });
    emitCommitStatus({
      ghPath: config.ghPath,
      repository: config.repository,
      headSha,
      runId,
      state: "error",
      description: `Artifact download/verify failed: ${downloadErr.message}`,
      runCommand,
    });
    throw downloadErr;
  }

  let stageResult;
  try {
    stageResult = stageRelease({
      root: config.root,
      headSha,
      manifest,
      artifactDir: downloadDir,
      npmPath: config.npmPath,
      nodePath: config.nodePath,
      runCommand,
    });
  } catch (stageErr) {
    writeStatusFile(config.root, {
      state: "error",
      runId,
      commit: headSha,
      error: stageErr.message,
      updatedAt: new Date().toISOString(),
    });
    writeLedgerFile(config.root, {
      lastHandledRunId: runId,
      lastHandledSha: headSha,
      lastHandledState: "error",
      lastHandledError: stageErr.message,
      updatedAt: new Date().toISOString(),
    });
    emitCommitStatus({
      ghPath: config.ghPath,
      repository: config.repository,
      headSha,
      runId,
      state: "error",
      description: `npm stage install failed: ${stageErr.message}`,
      runCommand,
    });
    throw stageErr;
  }

  // Contract safety: verify idle before changing live service
  const doubleIdleCheck = await verifyIdleForUpdate({
    currentCli: config.currentCli,
    paseoHome: config.paseoHome,
    runCommand,
    sleep,
    intervalMs: 5000,
  });

  if (!doubleIdleCheck.safe) {
    writeStatusFile(config.root, {
      state: "waiting",
      runId,
      commit: headSha,
      message: `System is busy, leaving staged version untouched: ${doubleIdleCheck.reason}`,
      updatedAt: new Date().toISOString(),
    });
    emitCommitStatus({
      ghPath: config.ghPath,
      repository: config.repository,
      headSha,
      runId,
      state: "pending",
      description: `System is busy, leaving staged version untouched: ${doubleIdleCheck.reason}`,
      runCommand,
    });
    return {
      status: "waiting",
      message: `System is busy, leaving staged version untouched: ${doubleIdleCheck.reason}`,
    };
  }

  const activation = await activateRelease({
    config,
    releaseDir: stageResult.releaseDir,
    manifest,
    runCommand,
    sleep,
    restartTimeoutMs,
  });

  if (!activation.ok) {
    writeStatusFile(config.root, {
      state: "error",
      runId,
      commit: headSha,
      error: activation.error,
      updatedAt: new Date().toISOString(),
    });
    writeLedgerFile(config.root, {
      lastHandledRunId: runId,
      lastHandledSha: headSha,
      lastHandledState: "error",
      lastHandledError: activation.error,
      updatedAt: new Date().toISOString(),
    });
    const recoveryDesc = activation.oldServiceReachable
      ? "prior service restored"
      : "CRITICAL: prior service unreachable";
    emitCommitStatus({
      ghPath: config.ghPath,
      repository: config.repository,
      headSha,
      runId,
      state: "error",
      description: `Activation failed (${recoveryDesc}): ${activation.error}`.slice(0, 140),
      runCommand,
    });
    if (activation.oldServiceReachable) {
      throw new Error(`Activation failed; prior service safely restored: ${activation.error}`);
    } else {
      throw new Error(
        `Activation failed; CRITICAL: rollback failed or prior service unreachable: ${activation.error}`,
      );
    }
  }

  writeStatusFile(config.root, {
    state: "success",
    runId,
    commit: headSha,
    version: manifest.version,
    updatedAt: new Date().toISOString(),
  });
  writeLedgerFile(config.root, {
    lastHandledRunId: runId,
    lastHandledSha: headSha,
    lastHandledState: "success",
    version: manifest.version,
    updatedAt: new Date().toISOString(),
  });

  emitCommitStatus({
    ghPath: config.ghPath,
    repository: config.repository,
    headSha,
    runId,
    state: "success",
    description: `Successfully activated personal daemon ${manifest.version}`,
    runCommand,
  });

  return {
    status: "success",
    runId,
    commit: headSha,
    version: manifest.version,
  };
}

export function parseArgs(argv) {
  let configPath = null;
  let checkOnly = false;

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--config") {
      configPath = argv[++i];
    } else if (arg === "--check") {
      checkOnly = true;
    } else if (arg.startsWith("--config=")) {
      configPath = arg.slice("--config=".length);
    }
  }

  if (!configPath) {
    throw new Error("Usage: node scripts/personal-daemon-update.mjs --config <file> [--check]");
  }

  return { configPath, checkOnly };
}

if (isMainModule(import.meta.url)) {
  try {
    const { configPath, checkOnly } = parseArgs(process.argv);
    const result = await runDaemonUpdate({ configPath, checkOnly });
    console.log(JSON.stringify(result, null, 2));
    process.exit(0);
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}
