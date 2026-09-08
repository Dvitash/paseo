import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule } from "./is-main-module.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

export function quoteSystemd(value) {
  if (typeof value !== "string" || /[\r\n]/.test(value) || value.includes("\0")) {
    throw new Error("Systemd values must be single-line strings");
  }
  return JSON.stringify(value.replaceAll("%", "%%").replaceAll("$", () => "$$"));
}

export function buildUpdaterUnits(config, searchPath, flockPath) {
  const script = path.join(config.root, "bin", "personal-daemon-update.mjs");
  const args = [
    flockPath,
    "--nonblock",
    path.join(config.root, "update.lock"),
    config.nodePath,
    script,
    "--config",
    path.join(config.root, "config.json"),
  ];
  return {
    service: `[Unit]\nDescription=Apply manually requested personal Paseo daemon updates\nAfter=network-online.target\n\n[Service]\nType=oneshot\nExecStart=${args.map(quoteSystemd).join(" ")}\nEnvironment=${quoteSystemd(`HOME=${os.homedir()}`)}\nEnvironment=${quoteSystemd(`PATH=${searchPath}`)}\nTimeoutStartSec=35min\nUMask=0077\nNoNewPrivileges=true\nNice=10\n`,
    timer:
      "[Unit]\nDescription=Check for manual Paseo update requests\n\n[Timer]\nOnBootSec=2min\nOnUnitInactiveSec=60s\nAccuracySec=10s\nUnit=paseo-personal-update.service\n\n[Install]\nWantedBy=timers.target\n",
  };
}

function executable(name) {
  return execFileSync("which", [name], { encoding: "utf8" }).trim();
}

export function installUpdater({ repository = "Dvitash/paseo", activate = false } = {}) {
  if (process.platform !== "linux") throw new Error("This installer requires Linux systemd --user");
  if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error("Invalid repository");
  const home = os.homedir();
  const root = path.join(home, ".local", "share", "paseo-personal");
  const configFile = path.join(root, "config.json");
  const existing = existsSync(configFile) ? JSON.parse(readFileSync(configFile, "utf8")) : null;
  if (existing && existing.repository !== repository)
    throw new Error("Existing updater belongs to another repository");
  const owner = repository.split("/")[0];
  const ghPath = executable("gh");
  const login = execFileSync(ghPath, ["api", "user", "--jq", ".login"], {
    encoding: "utf8",
  }).trim();
  if (login.toLowerCase() !== owner.toLowerCase())
    throw new Error("Authenticate gh as the personal repository owner first");
  const systemctlPath = executable("systemctl");
  execFileSync(systemctlPath, ["--user", "is-active", "--quiet", "paseo.service"]);
  const config = {
    repository,
    workflow: "personal-update-daemon.yml",
    owner: login,
    installedAt: existing?.installedAt ?? new Date().toISOString(),
    root,
    paseoHome: path.join(home, ".paseo"),
    service: "paseo.service",
    nodePath: process.execPath,
    npmPath: executable("npm"),
    ghPath,
    systemctlPath,
    currentCli: executable("paseo"),
    systemdUserDir: path.join(
      process.env.XDG_CONFIG_HOME || path.join(home, ".config"),
      "systemd",
      "user",
    ),
  };
  const binDir = path.join(root, "bin");
  mkdirSync(binDir, { recursive: true, mode: 0o700 });
  mkdirSync(config.systemdUserDir, { recursive: true });
  for (const file of [
    "personal-daemon-update.mjs",
    "personal-artifacts.mjs",
    "is-main-module.mjs",
  ]) {
    copyFileSync(path.join(SCRIPT_DIR, file), path.join(binDir, file));
  }
  writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  const searchPath = `${path.dirname(process.execPath)}:${process.env.PATH || "/usr/local/bin:/usr/bin:/bin"}`;
  const units = buildUpdaterUnits(config, searchPath, executable("flock"));
  writeFileSync(path.join(config.systemdUserDir, "paseo-personal-update.service"), units.service);
  writeFileSync(path.join(config.systemdUserDir, "paseo-personal-update.timer"), units.timer);
  execFileSync(systemctlPath, ["--user", "daemon-reload"], { stdio: "inherit" });
  if (activate) {
    execFileSync(systemctlPath, ["--user", "enable", "--now", "paseo-personal-update.timer"], {
      stdio: "inherit",
    });
  }
  console.log(`Updater installed at ${root}. Timer ${activate ? "enabled" : "not enabled"}.`);
  console.log(
    "The live Paseo daemon was not restarted. Only future successful manual update requests are eligible.",
  );
  return config;
}

if (isMainModule(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    const activate = args.includes("--activate");
    const repositoryIndex = args.indexOf("--repository");
    const repository = repositoryIndex === -1 ? "Dvitash/paseo" : args[repositoryIndex + 1];
    const accepted = new Set(["--activate", "--repository", repository]);
    if (!repository || args.some((arg) => !accepted.has(arg))) {
      throw new Error(
        "Usage: node scripts/install-personal-daemon-updater.mjs [--repository owner/repo] [--activate]",
      );
    }
    installUpdater({ repository, activate });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
