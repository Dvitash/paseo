import { execFileSync } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import concurrently from "concurrently";
import { isMainModule } from "./is-main-module.mjs";

export const HELP_TEXT = `Usage: node scripts/dev-tailnet.mjs [options]

Start Paseo daemon and web app exposed over Tailscale for remote dev testing.

Options:
  --daemon-only      Start daemon only (skip web app)
  --skip-build       Skip building server deps (npm run dev:server:watch)
  --port <port>      Pin daemon port (otherwise find a free port starting at 6768)
  --web-port <port>  Pin web port (otherwise find a free port starting at 8081)
  --dry-run          Find ports and print configuration without starting processes
  -h, --help         Show this help message`;

export function checkPlatform(platform = process.platform) {
  if (platform !== "linux" && platform !== "darwin") {
    throw new Error(
      `Unsupported platform: "${platform}". dev-tailnet requires Linux or macOS with Bash.`,
    );
  }
}

export function parseCliArgs(argv = process.argv.slice(2)) {
  const { values } = parseArgs({
    args: argv,
    options: {
      "daemon-only": { type: "boolean", default: false },
      "skip-build": { type: "boolean", default: false },
      port: { type: "string" },
      "web-port": { type: "string" },
      "dry-run": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: false,
  });
  if (values.help) return { help: true };

  const parsePort = (val, flag) => {
    const p = Number.parseInt(val, 10);
    if (!Number.isInteger(p) || p < 1 || p > 65535 || String(p) !== val.trim()) {
      throw new Error(`Invalid ${flag}: "${val}". Must be a valid port number (1-65535).`);
    }
    if (p === 6767)
      throw new Error("Port 6767 is reserved for production daemon and is prohibited.");
    return p;
  };

  const portExplicit = values.port !== undefined;
  const webPortExplicit = values["web-port"] !== undefined;
  const port = parsePort(values.port ?? "6768", "--port");
  const webPort = parsePort(values["web-port"] ?? "8081", "--web-port");
  if (!values["daemon-only"] && portExplicit && webPortExplicit && port === webPort) {
    throw new Error(`--port (${port}) and --web-port (${webPort}) cannot be the same.`);
  }

  return {
    daemonOnly: values["daemon-only"],
    skipBuild: values["skip-build"],
    port,
    webPort,
    portExplicit,
    webPortExplicit,
    dryRun: values["dry-run"],
    help: false,
  };
}

export function parseTailscaleStatus(raw) {
  let data;
  try {
    data = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch (err) {
    throw new Error(`Invalid Tailscale status JSON: ${err.message}`, { cause: err });
  }
  if (!data || typeof data !== "object") throw new Error("Invalid Tailscale status output.");
  if (data.BackendState !== "Running") {
    throw new Error(
      `Tailscale is not running (BackendState: "${data.BackendState || "unknown"}"). Please connect Tailscale first.`,
    );
  }

  const ips = data.Self?.TailscaleIPs;
  if (!Array.isArray(ips)) {
    throw new Error("No Tailscale IPv4 address found in Tailscale status.");
  }
  const ipv4 = ips.find((ip) => net.isIPv4(ip));
  if (!ipv4) throw new Error("No Tailscale IPv4 address found in Tailscale status.");

  const dnsName = data.Self?.DNSName;
  if (!dnsName || typeof dnsName !== "string" || !dnsName.trim()) {
    throw new Error("No Tailscale DNS name found in Tailscale status.");
  }

  return { tailscaleIp: ipv4, dnsName: dnsName.trim() };
}

export function queryTailscaleStatus() {
  try {
    const stdout = execFileSync("tailscale", ["status", "--json"], {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 10000,
    });
    return parseTailscaleStatus(stdout);
  } catch (err) {
    if (err.code === "ENOENT")
      throw new Error("Tailscale CLI ('tailscale') is not installed or not in PATH.", {
        cause: err,
      });
    throw new Error(
      `Failed to query Tailscale status: ${err.stderr?.toString().trim() || err.message}`,
      { cause: err },
    );
  }
}

export function buildTailnetHostnames(dnsName) {
  const trimmed = dnsName.replace(/\.+$/, "");
  if (!trimmed) return dnsName;
  return dnsName !== trimmed ? `${trimmed},${dnsName}` : trimmed;
}

export function resolveRepoRoot(metaUrl = import.meta.url) {
  return path.resolve(fileURLToPath(new URL("..", metaUrl)));
}

export function buildDevTailnetEnv({ root, tailscaleIp, dnsName, options, baseEnv = process.env }) {
  const env = { ...baseEnv };
  env.PASEO_DEV_SEED_HOME = undefined;
  env.PASEO_DEV_RESET_HOME = undefined;

  env.PASEO_HOME = path.join(root, ".dev", "paseo-home");
  env.PASEO_DEV_MANAGED_HOME = "1";
  env.PASEO_DEV_ROOT = root;
  env.PASEO_LISTEN = `${tailscaleIp}:${options.port}`;
  env.PASEO_DEV_DAEMON_ENDPOINT = `${tailscaleIp}:${options.port}`;
  env.PASEO_HOSTNAMES = buildTailnetHostnames(dnsName);
  env.EXPO_PORT = String(options.webPort);
  env.PASEO_SKIP_DEV_SERVER_BUILD = options.skipBuild ? "1" : "0";
  return env;
}

export function buildDevTailnetPlan({
  root,
  tailscaleIp,
  dnsName,
  options,
  baseEnv = process.env,
}) {
  const env = buildDevTailnetEnv({ root, tailscaleIp, dnsName, options, baseEnv });
  const trimmedDns = dnsName.replace(/\.+$/, "");

  const commands = [
    { command: "./scripts/dev-daemon.sh", name: "daemon", prefixColor: "cyan", env },
  ];
  if (!options.daemonOnly) {
    commands.push({ command: "./scripts/dev-app.sh", name: "web", prefixColor: "magenta", env });
  }

  const browserUrl = options.daemonOnly ? null : `http://${trimmedDns}:${options.webPort}`;

  return {
    root,
    tailscaleIp,
    dnsName,
    trimmedDns,
    browserUrl,
    daemonUrl: `http://${tailscaleIp}:${options.port}`,
    options,
    env,
    commands,
  };
}

export function formatPlanBanner(plan) {
  return [
    "══════════════════════════════════════════════════════",
    "  Paseo Tailnet Dev",
    "══════════════════════════════════════════════════════",
    `  Host:        ${plan.trimmedDns} (${plan.tailscaleIp})`,
    `  Daemon:      ${plan.daemonUrl}`,
    `  Web:         ${plan.options.daemonOnly ? "disabled (--daemon-only)" : `http://${plan.tailscaleIp}:${plan.options.webPort}`}`,
    "  SSL:         off (HTTP)",
    `  Browser URL: ${plan.browserUrl ?? "disabled (--daemon-only)"}`,
    `  Home:        ${plan.env.PASEO_HOME}`,
    "══════════════════════════════════════════════════════",
  ].join("\n");
}

export function checkPortFree(port, host = "0.0.0.0") {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", (err) => {
      if (err.code === "EADDRINUSE") {
        resolve(false);
        return;
      }
      reject(err);
    });
    server.listen(port, host, () => server.close(() => resolve(true)));
  });
}

async function isPortAvailable(port) {
  if (!(await checkPortFree(port, "0.0.0.0"))) return false;
  try {
    return await checkPortFree(port, "::");
  } catch (error) {
    if (error.code === "EAFNOSUPPORT" || error.code === "EADDRNOTAVAIL") return true;
    throw error;
  }
}

async function selectPort({ start, explicit, exclude, flag }, isFree) {
  const end = Math.min(65535, start + (explicit ? 0 : 99));
  for (let port = start; port <= end; port += 1) {
    if (port === 6767 || exclude.has(port)) continue;
    if (await isFree(port)) return port;
  }
  if (explicit) {
    throw new Error(
      `Port ${start} requested by ${flag} is occupied. Omit ${flag} to select a free port. No processes were stopped.`,
    );
  }
  throw new Error(
    `No free port found between ${start} and ${end}. Choose a different range with ${flag}. No processes were stopped.`,
  );
}

export async function selectDevPorts(options, isFree = isPortAvailable) {
  const exclude = new Set();
  if (options.webPortExplicit && !options.daemonOnly) exclude.add(options.webPort);
  const port = await selectPort(
    {
      start: options.port,
      explicit: options.portExplicit,
      exclude,
      flag: "--port",
    },
    isFree,
  );
  const webPort = options.daemonOnly
    ? options.webPort
    : await selectPort(
        {
          start: options.webPort,
          explicit: options.webPortExplicit,
          exclude: new Set([port]),
          flag: "--web-port",
        },
        isFree,
      );
  return { ...options, port, webPort };
}

export async function assertPortsAvailable({ port, webPort, tailscaleIp, daemonOnly }) {
  const daemonFree = await checkPortFree(port, tailscaleIp);
  if (!daemonFree) {
    throw new Error(
      `Port ${port} is already in use on ${tailscaleIp}. Stop your existing dev terminal or choose a different port with --port. No processes were stopped.`,
    );
  }
  if (!daemonOnly) {
    const webFree = await checkPortFree(webPort, "0.0.0.0");
    if (!webFree) {
      throw new Error(
        `Port ${webPort} is already in use. Stop your existing dev terminal or choose a different port with --web-port. No processes were stopped.`,
      );
    }
  }
}

export async function runDevTailnet(argv = process.argv.slice(2), overrides = {}) {
  const requestedOptions = parseCliArgs(argv);
  if (requestedOptions.help) {
    console.log(HELP_TEXT);
    return { exitCode: 0, help: true };
  }

  (overrides.checkPlatform ?? checkPlatform)();
  const { tailscaleIp, dnsName } = (overrides.queryTailscaleStatus ?? queryTailscaleStatus)();
  const root = overrides.root ?? resolveRepoRoot();
  const baseEnv = overrides.baseEnv ?? process.env;
  const options = await selectDevPorts(
    requestedOptions,
    overrides.isPortAvailable ?? isPortAvailable,
  );
  const plan = buildDevTailnetPlan({ root, tailscaleIp, dnsName, options, baseEnv });

  if (options.dryRun) {
    if (overrides.log !== false) {
      console.log(formatPlanBanner(plan));
      console.log("\n[dry-run] Commands:");
      for (const cmd of plan.commands)
        console.log(`  [${cmd.name}] ${cmd.command} (cwd: ${plan.root})`);
      console.log("\n[dry-run] Environment overrides:");
      for (const k of [
        "PASEO_HOME",
        "PASEO_DEV_MANAGED_HOME",
        "PASEO_LISTEN",
        "PASEO_DEV_DAEMON_ENDPOINT",
        "PASEO_HOSTNAMES",
        "EXPO_PORT",
        "PASEO_SKIP_DEV_SERVER_BUILD",
      ]) {
        console.log(`  ${k}=${plan.env[k]}`);
      }
    }
    return { exitCode: 0, plan };
  }

  await (overrides.assertPortsAvailable ?? assertPortsAvailable)({
    port: options.port,
    webPort: options.webPort,
    tailscaleIp,
    daemonOnly: options.daemonOnly,
  });

  if (overrides.log !== false) console.log(formatPlanBanner(plan));

  const spawnConcurrent = overrides.concurrently ?? concurrently;
  const runner = spawnConcurrent(plan.commands, {
    cwd: plan.root,
    killOthersOn: ["failure", "success"],
    prefixColors: ["cyan", "magenta"],
  });

  try {
    await runner.result;
  } catch (err) {
    if (Array.isArray(err)) {
      const nonzero = err.find((e) => typeof e?.exitCode === "number" && e.exitCode !== 0);
      const exitCode = nonzero?.exitCode ?? 1;
      return { exitCode, plan };
    }
    throw err;
  }

  return { exitCode: 0, plan };
}

if (isMainModule(import.meta.url)) {
  runDevTailnet()
    .then(({ exitCode = 0 } = {}) => {
      if (exitCode !== 0) process.exit(exitCode);
      return undefined;
    })
    .catch((err) => {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    });
}
