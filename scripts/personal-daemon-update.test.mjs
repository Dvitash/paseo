import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import zlib from "node:zlib";
import { EXPECTED_PACKAGES, EXPECTED_SERVER_WEB_ENTRY } from "./personal-artifacts.mjs";
import {
  CLI_DIST_RELPATH,
  DROPIN_FILENAME,
  RELEASE_COMPLETE_FILENAME,
  SERVER_WEB_INDEX_RELPATH,
  activateRelease,
  checkAgentStatus,
  checkServiceEligibility,
  downloadArtifactBundle,
  fetchEligibleWorkflowRun,
  generateDropInContent,
  parseDaemonStatusOutput,
  quoteSystemdArg,
  readLedgerFile,
  readStatusFile,
  runDaemonUpdate,
  stageRelease,
  validateConfig,
  verifyIdleForUpdate,
  writeLedgerFile,
  writeStatusFile,
} from "./personal-daemon-update.mjs";

async function withTempDir(prefix, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  try {
    return await fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("readLedgerFile: corrupt or incomplete ledger fails closed", async () => {
  await withTempDir("paseo-ledger-", (dir) => {
    assert.equal(readLedgerFile(dir), null);
    fs.writeFileSync(path.join(dir, "ledger.json"), "{");
    assert.throws(() => readLedgerFile(dir));
    fs.writeFileSync(path.join(dir, "ledger.json"), "{}");
    assert.throws(() => readLedgerFile(dir), /Invalid updater ledger/);
  });
});

test("checkServiceEligibility: inactive or unreachable systemd fails closed", () => {
  for (const status of [1, 3, 4, 124]) {
    assert.throws(
      () =>
        checkServiceEligibility({
          systemctlPath: "/usr/bin/systemctl",
          service: "paseo.service",
          runCommand: () => ({ status, stdout: "", stderr: "" }),
        }),
      /not active/,
    );
  }
});

function createMockTarGz(files) {
  const chunks = [];
  for (const file of files) {
    const content = Buffer.isBuffer(file.content) ? file.content : Buffer.from(file.content || "");
    const header = Buffer.alloc(512);

    header.write(file.name, 0, 100, "utf8");
    header.write("0000644\0", 100, 8, "utf8");
    header.write("0000000\0", 108, 8, "utf8");
    header.write("0000000\0", 116, 8, "utf8");
    const sizeOctal = `${content.length.toString(8).padStart(11, "0")}\0`;
    header.write(sizeOctal, 124, 12, "utf8");
    header.write("00000000000\0", 136, 12, "utf8");
    header.fill(32, 148, 156);
    header[156] = "0".charCodeAt(0);
    header.write("ustar\0", 257, 6, "utf8");
    header.write("00", 263, 2, "utf8");

    let checksum = 0;
    for (let i = 0; i < 512; i++) checksum += header[i];
    header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "utf8");

    chunks.push(header);
    if (content.length > 0) {
      chunks.push(content);
      const remainder = content.length % 512;
      if (remainder !== 0) chunks.push(Buffer.alloc(512 - remainder));
    }
  }
  chunks.push(Buffer.alloc(1024));
  return zlib.gzipSync(Buffer.concat(chunks));
}

const TEST_COMMIT = "1111222233334444555566667777888899990000";
const TEST_VERSION = "0.8.0-personal.1";

function createValidArtifactBundle(outputDir, commit = TEST_COMMIT, version = TEST_VERSION) {
  fs.mkdirSync(outputDir, { recursive: true });
  const packages = [];

  for (const pkgName of EXPECTED_PACKAGES) {
    const filename = `${pkgName.replace("@", "").replace("/", "-")}-${version}.tgz`;
    const filePath = path.join(outputDir, filename);

    let tarGzBuffer;
    if (pkgName === "@getpaseo/server") {
      tarGzBuffer = createMockTarGz([
        { name: EXPECTED_SERVER_WEB_ENTRY, content: "<!DOCTYPE html><html></html>" },
      ]);
    } else {
      tarGzBuffer = createMockTarGz([
        { name: "package/package.json", content: JSON.stringify({ name: pkgName, version }) },
      ]);
    }

    fs.writeFileSync(filePath, tarGzBuffer);
    const sha256 = crypto.createHash("sha256").update(tarGzBuffer).digest("hex");
    packages.push({ name: pkgName, file: filename, sha256 });
  }

  const manifest = {
    format: 1,
    commit,
    version,
    packages,
  };
  fs.writeFileSync(
    path.join(outputDir, "manifest.json"),
    JSON.stringify(manifest, null, 2),
    "utf8",
  );
  return manifest;
}

function makeMockConfig(dir, overrides = {}) {
  const nodePath = path.join(dir, "bin", "node");
  const npmPath = path.join(dir, "bin", "npm");
  const ghPath = path.join(dir, "bin", "gh");
  const systemctlPath = path.join(dir, "bin", "systemctl");
  const currentCli = path.join(dir, "bin", "paseo");

  fs.mkdirSync(path.join(dir, "bin"), { recursive: true });
  for (const p of [nodePath, npmPath, ghPath, systemctlPath, currentCli]) {
    if (!fs.existsSync(p)) {
      fs.writeFileSync(p, "#!/bin/sh\nexit 0", { mode: 0o755 });
    }
  }

  return {
    repository: "Dvitash/paseo",
    workflow: "personal-update-daemon.yml",
    owner: "Dvitash",
    installedAt: "2026-09-01T00:00:00.000Z",
    root: path.join(dir, "paseo-personal"),
    paseoHome: path.join(dir, "home"),
    service: "paseo.service",
    nodePath,
    npmPath,
    ghPath,
    systemctlPath,
    currentCli,
    systemdUserDir: path.join(dir, "systemd"),
    ...overrides,
  };
}

function makeRealisticRunDetails({
  id = 101,
  headSha = TEST_COMMIT,
  createdAt = "2026-09-05T12:00:00Z",
  owner = "Dvitash",
  repository = "Dvitash/paseo",
  workflow = "personal-update-daemon.yml",
  status = "completed",
  conclusion = "success",
  event = "workflow_dispatch",
  headBranch = "main",
} = {}) {
  return {
    id,
    head_sha: headSha,
    created_at: createdAt,
    status,
    conclusion,
    event,
    head_branch: headBranch,
    path: `.github/workflows/${workflow}`,
    actor: { login: owner },
    repository: { full_name: repository },
    head_repository: { full_name: repository },
  };
}

// 1. Config validation & systemd quoting tests
test("validateConfig: accepts fully specified absolute config", async () => {
  await withTempDir("config-test-", async (dir) => {
    const config = makeMockConfig(dir);
    const validated = validateConfig(config);
    assert.equal(validated.repository, "Dvitash/paseo");
    assert.equal(validated.owner, "Dvitash");
  });
});

test("validateConfig: rejects missing, path traversal, newlines, or control characters", async () => {
  await withTempDir("config-invalid-", async (dir) => {
    const config = makeMockConfig(dir);
    assert.throws(() => validateConfig({ ...config, repository: "invalid" }), /Invalid repository/);
    assert.throws(
      () => validateConfig({ ...config, installedAt: "not-a-date" }),
      /Invalid installedAt/,
    );
    assert.throws(() => validateConfig({ ...config, root: "relative/path" }), /must be absolute/);
    assert.throws(() => validateConfig({ ...config, owner: "" }), /Missing or empty/);
    assert.throws(
      () => validateConfig({ ...config, service: "../evil.service" }),
      /safe \.service basename/,
    );
    assert.throws(
      () => validateConfig({ ...config, service: "paseo.service\nDropIn=evil" }),
      /control characters or newlines/,
    );
    assert.throws(
      () => validateConfig({ ...config, root: "/tmp/root\n" }),
      /control characters or newlines/,
    );
  });
});

test("quoteSystemdArg: safely quotes paths and escapes % and $ and quotes", () => {
  assert.equal(quoteSystemdArg("/usr/bin/node"), `"/usr/bin/node"`);
  assert.equal(quoteSystemdArg("/home/user/$FOO%u/path"), `"/home/user/$$FOO%%u/path"`);
  assert.equal(
    quoteSystemdArg('path with "quotes" and \\backslashes\\'),
    `"path with \\"quotes\\" and \\\\backslashes\\\\"`,
  );
});

test("generateDropInContent: creates valid ExecStart clear and quoted command", async () => {
  await withTempDir("dropin-content-", async (dir) => {
    const config = makeMockConfig(dir, {
      paseoHome: "/home/user/$VAR%n/home",
    });
    const content = generateDropInContent(config);
    assert.ok(content.startsWith("[Service]\nExecStart=\nExecStart="));
    assert.ok(content.includes('"/home/user/$$VAR%%n/home"'));
    assert.ok(content.includes("daemon start --foreground --home"));
  });
});

// 2. Provenance and workflow run filtering tests
test("fetchEligibleWorkflowRun: selects newest valid dispatch on main and validates full provenance", async () => {
  await withTempDir("prov-test-", async (dir) => {
    const config = makeMockConfig(dir);
    const runsList = [
      {
        databaseId: 101,
        headSha: TEST_COMMIT,
        createdAt: "2026-09-05T12:00:00Z",
        status: "completed",
        conclusion: "success",
        event: "workflow_dispatch",
      },
      {
        databaseId: 99,
        headSha: "0000000000000000000000000000000000000000",
        createdAt: "2026-08-20T12:00:00Z", // Older than installedAt (2026-09-01)
        status: "completed",
        conclusion: "success",
        event: "workflow_dispatch",
      },
    ];

    const runDetails = makeRealisticRunDetails({ id: 101, headSha: TEST_COMMIT });

    const mockRunCommand = (cmd, args) => {
      if (args[0] === "run" && args[1] === "list") {
        return { status: 0, stdout: JSON.stringify(runsList), stderr: "" };
      }
      if (args[0] === "api" && args[1].includes("/actions/runs/101")) {
        return { status: 0, stdout: JSON.stringify(runDetails), stderr: "" };
      }
      return { status: 1, stdout: "", stderr: "unknown command" };
    };

    const result = fetchEligibleWorkflowRun({
      ghPath: config.ghPath,
      repository: config.repository,
      workflow: config.workflow,
      owner: config.owner,
      installedAt: config.installedAt,
      root: config.root,
      runCommand: mockRunCommand,
    });

    assert.ok(result);
    assert.equal(result.runId, 101);
    assert.equal(result.headSha, TEST_COMMIT);
  });
});

test("fetchEligibleWorkflowRun: rejects runs with mismatched actor, repository, SHA, or workflow path", async () => {
  await withTempDir("prov-mismatch-", async (dir) => {
    const config = makeMockConfig(dir);
    const runsList = [
      {
        databaseId: 201,
        headSha: TEST_COMMIT,
        createdAt: "2026-09-05T12:00:00Z",
        status: "completed",
        conclusion: "success",
        event: "workflow_dispatch",
      },
    ];

    // Wrong actor
    const mockWrongActor = (cmd, args) => {
      if (args[0] === "run" && args[1] === "list")
        return { status: 0, stdout: JSON.stringify(runsList), stderr: "" };
      if (args[0] === "api")
        return {
          status: 0,
          stdout: JSON.stringify(makeRealisticRunDetails({ owner: "Attacker" })),
          stderr: "",
        };
      return { status: 1, stdout: "", stderr: "" };
    };
    assert.equal(fetchEligibleWorkflowRun({ ...config, runCommand: mockWrongActor }), null);

    // Wrong repo
    const mockWrongRepo = (cmd, args) => {
      if (args[0] === "run" && args[1] === "list")
        return { status: 0, stdout: JSON.stringify(runsList), stderr: "" };
      if (args[0] === "api")
        return {
          status: 0,
          stdout: JSON.stringify(makeRealisticRunDetails({ repository: "Attacker/paseo" })),
          stderr: "",
        };
      return { status: 1, stdout: "", stderr: "" };
    };
    assert.equal(fetchEligibleWorkflowRun({ ...config, runCommand: mockWrongRepo }), null);

    // Suffix/inexact workflow path
    const mockWrongPath = (cmd, args) => {
      if (args[0] === "run" && args[1] === "list")
        return { status: 0, stdout: JSON.stringify(runsList), stderr: "" };
      if (args[0] === "api") {
        const details = makeRealisticRunDetails();
        details.path = ".github/workflows/other-personal-update-daemon.yml";
        return { status: 0, stdout: JSON.stringify(details), stderr: "" };
      }
      return { status: 1, stdout: "", stderr: "" };
    };
    assert.equal(fetchEligibleWorkflowRun({ ...config, runCommand: mockWrongPath }), null);
  });
});

test("fetchEligibleWorkflowRun: selects newest valid run ONLY and never falls back to older runs (no A/B toggle)", async () => {
  await withTempDir("prov-no-ab-toggle-", async (dir) => {
    const config = makeMockConfig(dir);
    const SHA_NEW = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const SHA_OLD = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    const runsList = [
      {
        databaseId: 402,
        headSha: SHA_NEW,
        createdAt: "2026-09-08T12:00:00Z",
        status: "completed",
        conclusion: "success",
        event: "workflow_dispatch",
      },
      {
        databaseId: 401,
        headSha: SHA_OLD,
        createdAt: "2026-09-05T12:00:00Z",
        status: "completed",
        conclusion: "success",
        event: "workflow_dispatch",
      },
    ];

    // Case 1: SHA_NEW is already recorded as handled in ledger -> returns null, DOES NOT pick SHA_OLD
    writeLedgerFile(config.root, {
      lastHandledRunId: 402,
      lastHandledSha: SHA_NEW,
      lastHandledState: "success",
    });

    const mockRunCommand = (cmd, args) => {
      if (args[0] === "run" && args[1] === "list") {
        return { status: 0, stdout: JSON.stringify(runsList), stderr: "" };
      }
      if (args[0] === "api" && args[1].includes("/actions/runs/402")) {
        return {
          status: 0,
          stdout: JSON.stringify(
            makeRealisticRunDetails({
              id: 402,
              headSha: SHA_NEW,
              createdAt: "2026-09-08T12:00:00Z",
            }),
          ),
          stderr: "",
        };
      }
      if (args[0] === "api" && args[1].includes("/actions/runs/401")) {
        return {
          status: 0,
          stdout: JSON.stringify(
            makeRealisticRunDetails({
              id: 401,
              headSha: SHA_OLD,
              createdAt: "2026-09-05T12:00:00Z",
            }),
          ),
          stderr: "",
        };
      }
      return { status: 1, stdout: "", stderr: "" };
    };

    const result = fetchEligibleWorkflowRun({
      ghPath: config.ghPath,
      repository: config.repository,
      workflow: config.workflow,
      owner: config.owner,
      installedAt: config.installedAt,
      root: config.root,
      runCommand: mockRunCommand,
    });

    // Must be null! If it returned 401/SHA_OLD, it would flip-flop!
    assert.equal(result, null);
  });
});

test("consecutive polls: preserves terminal error and ledger suppression across multiple no-op ticks", async () => {
  await withTempDir("consecutive-ticks-", async (dir) => {
    const config = makeMockConfig(dir);
    const configPath = path.join(dir, "config.json");
    fs.writeFileSync(configPath, JSON.stringify(config), "utf8");

    const SHA_FAILED = "ffffffffffffffffffffffffffffffffffffffff";
    const runsList = [
      {
        databaseId: 701,
        headSha: SHA_FAILED,
        createdAt: "2026-09-05T12:00:00Z",
        status: "completed",
        conclusion: "success",
        event: "workflow_dispatch",
      },
    ];

    // Seed state as already failed for run 701
    writeStatusFile(config.root, {
      state: "error",
      runId: 701,
      commit: SHA_FAILED,
      error: "Previous build failure",
    });
    writeLedgerFile(config.root, {
      lastHandledRunId: 701,
      lastHandledSha: SHA_FAILED,
      lastHandledState: "error",
      lastHandledError: "Previous build failure",
    });

    const mockRunCommand = (cmd, args) => {
      if (args[0] === "auth" && args[1] === "status")
        return { status: 0, stdout: "ok", stderr: "" };
      if (args[0] === "api" && args[1].startsWith("repos/")) {
        if (args[1].includes("actions/runs/701")) {
          return {
            status: 0,
            stdout: JSON.stringify(makeRealisticRunDetails({ id: 701, headSha: SHA_FAILED })),
            stderr: "",
          };
        }
        return { status: 0, stdout: "ok", stderr: "" };
      }
      if (args[1] === "status" && args[2] === config.service)
        return { status: 0, stdout: "active", stderr: "" };
      if (args[0] === "ls")
        return {
          status: 0,
          stdout: JSON.stringify([{ shortId: "1", status: "idle" }]),
          stderr: "",
        };
      if (args[0] === "run" && args[1] === "list")
        return { status: 0, stdout: JSON.stringify(runsList), stderr: "" };
      return { status: 0, stdout: "", stderr: "" };
    };

    // Poll 1
    const tick1 = await runDaemonUpdate({
      configPath,
      runCommand: mockRunCommand,
      sleep: async () => {},
    });
    assert.equal(tick1.status, "error");

    const status1 = readStatusFile(config.root);
    assert.equal(status1.state, "error");
    const ledger1 = readLedgerFile(config.root);
    assert.equal(ledger1.lastHandledState, "error");

    // Poll 2
    const tick2 = await runDaemonUpdate({
      configPath,
      runCommand: mockRunCommand,
      sleep: async () => {},
    });
    assert.equal(tick2.status, "error");

    const status2 = readStatusFile(config.root);
    assert.equal(status2.state, "error");

    // Poll 3
    const tick3 = await runDaemonUpdate({
      configPath,
      runCommand: mockRunCommand,
      sleep: async () => {},
    });
    assert.equal(tick3.status, "error");
  });
});

// 3. Artifact download and integrity tests before npm
test("downloadArtifactBundle: rejects corrupted checksum before npm install", async () => {
  await withTempDir("corrupt-test-", async (dir) => {
    const config = makeMockConfig(dir);
    const downloadDir = path.join(dir, "download");
    createValidArtifactBundle(downloadDir, TEST_COMMIT, TEST_VERSION);

    // Tamper with one tarball
    const pkg = EXPECTED_PACKAGES[0].replace("@", "").replace("/", "-");
    const tarball = path.join(downloadDir, `${pkg}-${TEST_VERSION}.tgz`);
    fs.writeFileSync(tarball, Buffer.from("corrupted bytes"));

    const mockRunCommand = () => ({ status: 0, stdout: "Downloaded", stderr: "" });

    assert.throws(
      () =>
        downloadArtifactBundle({
          ghPath: config.ghPath,
          repository: config.repository,
          runId: 101,
          headSha: TEST_COMMIT,
          targetDir: downloadDir,
          runCommand: mockRunCommand,
        }),
      /Checksum mismatch/,
    );
  });
});

// 4. Idle checking and fail-closed safety tests
test("checkAgentStatus: safe when all agents are idle/closed and no side-chats", async () => {
  await withTempDir("idle-safe-", async (dir) => {
    const config = makeMockConfig(dir);
    const agentList = [
      { shortId: "ag-1", name: "pi", status: "idle" },
      { shortId: "ag-2", name: "coder", status: "closed" },
    ];

    const mockRunCommand = (cmd, args) => {
      assert.equal(args[0], "ls");
      return { status: 0, stdout: JSON.stringify(agentList), stderr: "" };
    };

    const status = checkAgentStatus({
      currentCli: config.currentCli,
      paseoHome: config.paseoHome,
      runCommand: mockRunCommand,
    });
    assert.equal(status.safe, true);
  });
});

test("checkAgentStatus: fails closed on unknown agent status or non-zero exit", async () => {
  await withTempDir("idle-unknown-", async (dir) => {
    const config = makeMockConfig(dir);

    // Non-zero exit code
    assert.throws(
      () =>
        checkAgentStatus({
          currentCli: config.currentCli,
          paseoHome: config.paseoHome,
          runCommand: () => ({ status: 1, stdout: "", stderr: "Connection refused" }),
        }),
      /CLI agent ls command failed/,
    );

    // Unknown agent status (not idle, closed, or error)
    const unknownAgentList = [{ shortId: "ag-x", name: "agent-x", status: "thinking_weird" }];
    assert.throws(
      () =>
        checkAgentStatus({
          currentCli: config.currentCli,
          paseoHome: config.paseoHome,
          runCommand: () => ({ status: 0, stdout: JSON.stringify(unknownAgentList), stderr: "" }),
        }),
      /Unknown agent status 'thinking_weird'/,
    );
  });
});

test("checkAgentStatus: reports busy if agent is running", async () => {
  await withTempDir("idle-busy-agent-", async (dir) => {
    const config = makeMockConfig(dir);
    const agentList = [
      { shortId: "ag-1", name: "pi", status: "idle" },
      { shortId: "ag-2", name: "worker", status: "running" },
    ];

    const status = checkAgentStatus({
      currentCli: config.currentCli,
      paseoHome: config.paseoHome,
      runCommand: () => ({ status: 0, stdout: JSON.stringify(agentList), stderr: "" }),
    });

    assert.equal(status.safe, false);
    assert.match(status.reason, /Agent ag-2 is running/);
  });
});

test("verifyIdleForUpdate: performs two checks separated by interval and returns false if second is busy", async () => {
  let callCount = 0;
  const mockRunCommand = () => {
    callCount++;
    if (callCount === 1) {
      return { status: 0, stdout: JSON.stringify([{ shortId: "1", status: "idle" }]), stderr: "" };
    }
    return { status: 0, stdout: JSON.stringify([{ shortId: "1", status: "running" }]), stderr: "" };
  };

  let sleptMs = 0;
  const mockSleep = async (ms) => {
    sleptMs += ms;
  };

  const result = await verifyIdleForUpdate({
    currentCli: "/mock/bin/paseo",
    paseoHome: "/mock/home",
    runCommand: mockRunCommand,
    sleep: mockSleep,
    intervalMs: 5000,
  });

  assert.equal(result.safe, false);
  assert.equal(sleptMs, 5000);
  assert.equal(callCount, 2);
});

test("parseDaemonStatusOutput: parses direct object, wrapped data, and key-value list rows", () => {
  const direct = JSON.stringify({
    localDaemon: "running",
    connectedDaemon: "reachable",
    daemonVersion: "0.7.2",
  });
  const parsedDirect = parseDaemonStatusOutput(direct);
  assert.equal(parsedDirect.localDaemon, "running");
  assert.equal(parsedDirect.connectedDaemon, "reachable");
  assert.equal(parsedDirect.daemonVersion, "0.7.2");
});

// 5. Staging and installation tests
test("stageRelease: installs packages, verifies CLI and web index, writes completion marker", async () => {
  await withTempDir("stage-test-", async (dir) => {
    const config = makeMockConfig(dir);
    const artifactDir = path.join(dir, "artifacts");
    const manifest = createValidArtifactBundle(artifactDir, TEST_COMMIT, TEST_VERSION);

    const mockRunCommand = (cmd, args) => {
      if (cmd === config.npmPath) {
        assert.equal(args[0], "install");
        assert.ok(args.includes("--omit=dev"));
        assert.ok(args.includes("--no-audit"));
        assert.ok(args.includes("--no-fund"));

        const prefixIdx = args.indexOf("--prefix");
        const stageTarget = args[prefixIdx + 1];
        const cliPath = path.join(stageTarget, CLI_DIST_RELPATH);
        const webPath = path.join(stageTarget, SERVER_WEB_INDEX_RELPATH);
        fs.mkdirSync(path.dirname(cliPath), { recursive: true });
        fs.mkdirSync(path.dirname(webPath), { recursive: true });
        fs.writeFileSync(cliPath, "#!/usr/bin/env node\nconsole.log(process.argv)", "utf8");
        fs.writeFileSync(webPath, "<!DOCTYPE html><html></html>", "utf8");
        return { status: 0, stdout: "added 7 packages", stderr: "" };
      }
      if (cmd === config.nodePath && args[1] === "--version") {
        return { status: 0, stdout: `${TEST_VERSION}\n`, stderr: "" };
      }
      return { status: 0, stdout: "", stderr: "" };
    };

    const staged = stageRelease({
      root: config.root,
      headSha: TEST_COMMIT,
      manifest,
      artifactDir,
      npmPath: config.npmPath,
      nodePath: config.nodePath,
      runCommand: mockRunCommand,
    });

    assert.equal(staged.reused, false);
    assert.equal(staged.version, TEST_VERSION);
    assert.ok(fs.existsSync(staged.releaseDir));
    assert.ok(fs.existsSync(path.join(staged.releaseDir, RELEASE_COMPLETE_FILENAME)));

    // Second call reuses completed stage
    const reused = stageRelease({
      root: config.root,
      headSha: TEST_COMMIT,
      manifest,
      artifactDir,
      npmPath: config.npmPath,
      nodePath: config.nodePath,
      runCommand: mockRunCommand,
    });
    assert.equal(reused.reused, true);
  });
});

test("stageRelease: fails closed if target release directory exists but verification fails (no overwrite/delete)", async () => {
  await withTempDir("stage-fail-closed-", async (dir) => {
    const config = makeMockConfig(dir);
    const artifactDir = path.join(dir, "artifacts");
    const manifest = createValidArtifactBundle(artifactDir, TEST_COMMIT, TEST_VERSION);

    const targetReleaseDir = path.join(config.root, "releases", TEST_COMMIT);
    fs.mkdirSync(targetReleaseDir, { recursive: true });
    // Write corrupted/unverified content into existing target
    fs.writeFileSync(path.join(targetReleaseDir, "existing.txt"), "precious user files");

    assert.throws(
      () =>
        stageRelease({
          root: config.root,
          headSha: TEST_COMMIT,
          manifest,
          artifactDir,
          npmPath: config.npmPath,
          nodePath: config.nodePath,
          runCommand: () => ({ status: 0, stdout: "", stderr: "" }),
        }),
      /Target release directory .* already exists but verification failed; refusing to overwrite or delete/,
    );

    // Ensure existing directory was NOT deleted
    assert.ok(fs.existsSync(path.join(targetReleaseDir, "existing.txt")));
  });
});

// 6. Activation, switch, and health check tests
test("activateRelease: swaps symlink atomically, writes drop-in override, reloads and restarts", async () => {
  await withTempDir("activate-test-", async (dir) => {
    const config = makeMockConfig(dir);
    const releaseDir = path.join(config.root, "releases", TEST_COMMIT);
    fs.mkdirSync(releaseDir, { recursive: true });

    const executedCommands = [];
    const mockRunCommand = (cmd, args) => {
      executedCommands.push({ cmd, args });
      if (cmd === config.systemctlPath && args[1] === "is-active") {
        return { status: 0, stdout: "active\n", stderr: "" };
      }
      if (args.includes("daemon") && args.includes("status")) {
        return {
          status: 0,
          stdout: JSON.stringify({
            localDaemon: "running",
            connectedDaemon: "reachable",
            daemonVersion: TEST_VERSION,
          }),
          stderr: "",
        };
      }
      return { status: 0, stdout: "", stderr: "" };
    };

    const manifest = { commit: TEST_COMMIT, version: TEST_VERSION };
    const result = await activateRelease({
      config,
      releaseDir,
      manifest,
      runCommand: mockRunCommand,
      sleep: async () => {},
    });

    assert.equal(result.ok, true);

    const currentLink = path.join(config.root, "current");
    assert.equal(fs.readlinkSync(currentLink), releaseDir);

    const dropInPath = path.join(config.systemdUserDir, `${config.service}.d`, DROPIN_FILENAME);
    assert.ok(fs.existsSync(dropInPath));
    const dropInContent = fs.readFileSync(dropInPath, "utf8");
    assert.ok(dropInContent.includes("ExecStart=\n"));
    assert.ok(dropInContent.includes("daemon start --foreground --home"));
  });
});

// 7. Rollback on failed health check test
test("activateRelease: rolls back symlink and drop-in on health check failure, preserves old release and reports recovery health", async () => {
  await withTempDir("rollback-test-", async (dir) => {
    const config = makeMockConfig(dir);
    const oldRelease = path.join(
      config.root,
      "releases",
      "0000000000000000000000000000000000000000",
    );
    const newRelease = path.join(config.root, "releases", TEST_COMMIT);
    fs.mkdirSync(oldRelease, { recursive: true });
    fs.mkdirSync(newRelease, { recursive: true });

    const currentLink = path.join(config.root, "current");
    fs.symlinkSync(oldRelease, currentLink);

    const dropInDir = path.join(config.systemdUserDir, `${config.service}.d`);
    fs.mkdirSync(dropInDir, { recursive: true });
    const dropInPath = path.join(dropInDir, DROPIN_FILENAME);
    fs.writeFileSync(dropInPath, "# Original Dropin", "utf8");

    let rolledBack = false;
    const mockRunCommand = (cmd, args) => {
      if (cmd === config.systemctlPath && args[1] === "is-active") {
        return { status: 0, stdout: "active\n", stderr: "" };
      }
      if (cmd === config.systemctlPath && args[1] === "restart") {
        if (rolledBack) {
          // Rollback restart
          return { status: 0, stdout: "", stderr: "" };
        }
        return { status: 0, stdout: "", stderr: "" };
      }
      if (args.includes("daemon") && args.includes("status")) {
        // Check if current symlink has been restored to oldRelease
        let currentTarget = null;
        try {
          currentTarget = fs.readlinkSync(currentLink);
        } catch {}
        if (currentTarget === oldRelease) {
          rolledBack = true;
          return {
            status: 0,
            stdout: JSON.stringify({
              localDaemon: "running",
              connectedDaemon: "reachable",
              daemonVersion: "0.7.0",
            }),
            stderr: "",
          };
        }
        return {
          status: 1,
          stdout: "",
          stderr: "Daemon failed to start on new version",
        };
      }
      return { status: 0, stdout: "", stderr: "" };
    };

    const manifest = { commit: TEST_COMMIT, version: TEST_VERSION };
    const result = await activateRelease({
      config,
      releaseDir: newRelease,
      manifest,
      runCommand: mockRunCommand,
      sleep: async () => {},
      maxWaitMs: 100,
      pollIntervalMs: 20,
    });

    assert.equal(result.ok, false);
    assert.equal(result.oldServiceReachable, true);
    assert.match(result.error, /Rollback status:/);
    assert.match(result.error, /oldServiceReachable: true/);

    assert.equal(fs.readlinkSync(currentLink), oldRelease);
    assert.equal(fs.readFileSync(dropInPath, "utf8"), "# Original Dropin");
    assert.ok(fs.existsSync(oldRelease));
    assert.ok(fs.existsSync(newRelease));
  });
});

test("activateRelease: reports oldServiceReachable false if restored daemon probe fails", async () => {
  await withTempDir("rollback-failed-probe-", async (dir) => {
    const config = makeMockConfig(dir);
    const oldRelease = path.join(
      config.root,
      "releases",
      "0000000000000000000000000000000000000000",
    );
    const newRelease = path.join(config.root, "releases", TEST_COMMIT);
    fs.mkdirSync(oldRelease, { recursive: true });
    fs.mkdirSync(newRelease, { recursive: true });

    const currentLink = path.join(config.root, "current");
    fs.symlinkSync(oldRelease, currentLink);

    const dropInDir = path.join(config.systemdUserDir, `${config.service}.d`);
    fs.mkdirSync(dropInDir, { recursive: true });
    const dropInPath = path.join(dropInDir, DROPIN_FILENAME);
    fs.writeFileSync(dropInPath, "# Original Dropin", "utf8");

    // Both new version and restored version fail daemon status probe
    const mockRunCommand = (cmd, args) => {
      if (cmd === config.systemctlPath && args[1] === "is-active") {
        return { status: 0, stdout: "active\n", stderr: "" };
      }
      if (args.includes("daemon") && args.includes("status")) {
        return {
          status: 1,
          stdout: "",
          stderr: "Restored daemon completely dead",
        };
      }
      return { status: 0, stdout: "", stderr: "" };
    };

    const manifest = { commit: TEST_COMMIT, version: TEST_VERSION };
    const result = await activateRelease({
      config,
      releaseDir: newRelease,
      manifest,
      runCommand: mockRunCommand,
      sleep: async () => {},
      maxWaitMs: 100,
      pollIntervalMs: 20,
    });

    assert.equal(result.ok, false);
    assert.equal(result.oldServiceReachable, false);
    assert.match(result.error, /oldServiceReachable: false/);
    assert.match(result.error, /active_but_status_probe_failed/);
  });
});

// 8. Nonmutating --check mode test
test("runDaemonUpdate: --check mode is nonmutating and reports eligibility", async () => {
  await withTempDir("check-mode-test-", async (dir) => {
    const config = makeMockConfig(dir);
    const configPath = path.join(dir, "config.json");
    fs.writeFileSync(configPath, JSON.stringify(config), "utf8");

    const runsList = [
      {
        databaseId: 501,
        headSha: TEST_COMMIT,
        createdAt: "2026-09-05T12:00:00Z",
        status: "completed",
        conclusion: "success",
        event: "workflow_dispatch",
      },
    ];

    const mockRunCommand = (cmd, args) => {
      if (args[0] === "auth" && args[1] === "status")
        return { status: 0, stdout: "Logged in", stderr: "" };
      if (args[0] === "api" && args[1].startsWith("repos/")) {
        if (args[1].includes("actions/runs")) {
          return {
            status: 0,
            stdout: JSON.stringify(makeRealisticRunDetails({ id: 501 })),
            stderr: "",
          };
        }
        return { status: 0, stdout: "Dvitash/paseo", stderr: "" };
      }
      if (args[1] === "status" && args[2] === config.service)
        return { status: 0, stdout: "active", stderr: "" };
      if (args[0] === "ls")
        return {
          status: 0,
          stdout: JSON.stringify([{ shortId: "1", status: "idle" }]),
          stderr: "",
        };
      if (args[0] === "run" && args[1] === "list")
        return { status: 0, stdout: JSON.stringify(runsList), stderr: "" };
      return { status: 0, stdout: "", stderr: "" };
    };

    const checkResult = await runDaemonUpdate({
      configPath,
      checkOnly: true,
      runCommand: mockRunCommand,
      sleep: async () => {},
    });

    assert.equal(checkResult.eligible, true);
    assert.equal(checkResult.idle, true);
    assert.equal(checkResult.pendingRun.commit, TEST_COMMIT);

    // Verify NO mutations occurred:
    assert.equal(fs.existsSync(path.join(config.root, "releases")), false);
    assert.equal(fs.existsSync(path.join(config.root, "current")), false);
    assert.equal(fs.existsSync(path.join(config.systemdUserDir, `${config.service}.d`)), false);
  });
});
