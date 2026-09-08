import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { isMainModule } from "./is-main-module.mjs";

export const EXPECTED_PACKAGES = [
  "@getpaseo/highlight",
  "@getpaseo/protocol",
  "@getpaseo/client",
  "@getpaseo/plugin",
  "@getpaseo/relay",
  "@getpaseo/server",
  "@getpaseo/cli",
];

export const EXPECTED_SERVER_WEB_ENTRY = "package/dist/server/web-ui/index.html";

export function isSafeBasename(file) {
  if (typeof file !== "string" || !file.trim()) {
    return false;
  }
  if (path.basename(file) !== file) {
    return false;
  }
  if (file === "." || file === "..") {
    return false;
  }
  if (/[/\\]/.test(file)) {
    return false;
  }
  return /^[a-zA-Z0-9._-]+\.(tgz|tar\.gz)$/.test(file);
}

export function computeSha256(filePathOrBuffer) {
  const hash = crypto.createHash("sha256");
  if (Buffer.isBuffer(filePathOrBuffer)) {
    hash.update(filePathOrBuffer);
  } else {
    hash.update(fs.readFileSync(filePathOrBuffer));
  }
  return hash.digest("hex");
}

export function getTarEntries(tarGzPathOrBuffer) {
  const buffer = Buffer.isBuffer(tarGzPathOrBuffer)
    ? tarGzPathOrBuffer
    : fs.readFileSync(tarGzPathOrBuffer);

  const decompressed = zlib.gunzipSync(buffer);
  const entries = [];
  let offset = 0;
  let nextName = null;

  while (offset + 512 <= decompressed.length) {
    const header = decompressed.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) {
      break;
    }

    const nameEnd = header.indexOf(0, 0);
    const rawName = header
      .subarray(0, nameEnd === -1 || nameEnd > 100 ? 100 : nameEnd)
      .toString("utf8")
      .trim();
    const sizeStr = header.subarray(124, 136).toString("utf8").trim().replaceAll("\0", "");
    const size = Number.parseInt(sizeStr, 8) || 0;
    const typeFlag = String.fromCharCode(header[156]);

    let fullName = rawName;
    const magic = header.subarray(257, 262).toString("utf8");
    if (magic === "ustar") {
      const prefixEnd = header.indexOf(0, 345);
      const prefix = header
        .subarray(345, prefixEnd === -1 || prefixEnd > 500 ? 500 : prefixEnd)
        .toString("utf8")
        .trim();
      if (prefix) {
        fullName = `${prefix}/${rawName}`;
      }
    }

    if (typeFlag === "L") {
      const data = decompressed.subarray(offset + 512, offset + 512 + size);
      const nullIdx = data.indexOf(0);
      nextName = data.subarray(0, nullIdx === -1 ? size : nullIdx).toString("utf8");
    } else {
      const resolvedName = nextName || fullName;
      nextName = null;
      if (resolvedName) {
        entries.push({ name: resolvedName, size, type: typeFlag });
      }
    }

    offset += 512 + Math.ceil(size / 512) * 512;
  }

  return entries;
}

export function tarpackIncludesWebEntry(tarballPathOrBuffer, webEntry = EXPECTED_SERVER_WEB_ENTRY) {
  const entries = getTarEntries(tarballPathOrBuffer);
  return entries.some(
    (entry) =>
      entry.name === webEntry ||
      entry.name.endsWith(`/${webEntry}`) ||
      entry.name.endsWith("dist/server/web-ui/index.html"),
  );
}

export function checkBuildPrerequisites(repoRoot) {
  const requiredPaths = [
    {
      path: path.join(repoRoot, "packages/server/dist/server/web-ui/index.html"),
      remedy: "npm run build:daemon-web-ui",
      description: "exported browser web UI",
    },
    {
      path: path.join(repoRoot, "packages/server/dist/scripts/supervisor-entrypoint.js"),
      remedy: "npm run build:server",
      description: "server supervisor entrypoint",
    },
    {
      path: path.join(repoRoot, "packages/cli/dist/index.js"),
      remedy: "npm run build:server",
      description: "CLI build output",
    },
    {
      path: path.join(repoRoot, "packages/client/dist"),
      remedy: "npm run build:server",
      description: "client package build output",
    },
    {
      path: path.join(repoRoot, "packages/protocol/dist"),
      remedy: "npm run build:server",
      description: "protocol package build output",
    },
    {
      path: path.join(repoRoot, "packages/relay/dist"),
      remedy: "npm run build:server",
      description: "relay package build output",
    },
    {
      path: path.join(repoRoot, "packages/highlight/dist"),
      remedy: "npm run build:server",
      description: "highlight package build output",
    },
    {
      path: path.join(repoRoot, "packages/plugin/dist"),
      remedy: "npm run build:server",
      description: "plugin package build output",
    },
  ];

  const missing = [];
  for (const item of requiredPaths) {
    if (!fs.existsSync(item.path)) {
      missing.push(item);
    }
  }

  if (missing.length > 0) {
    const details = missing
      .map(
        (item) =>
          `  - Missing ${item.description} at ${path.relative(repoRoot, item.path)} (run: ${item.remedy})`,
      )
      .join("\n");
    throw new Error(`Build prerequisites check failed:\n${details}`);
  }

  return true;
}

function validateManifestPackage(pkg, packageNames, seenFiles) {
  if (!pkg || typeof pkg !== "object") {
    throw new Error("Each manifest package entry must be an object");
  }

  if (!EXPECTED_PACKAGES.includes(pkg.name)) {
    throw new Error(`Unexpected package name in manifest: ${pkg.name}`);
  }

  if (packageNames.has(pkg.name)) {
    throw new Error(`Duplicate package name in manifest: ${pkg.name}`);
  }
  packageNames.add(pkg.name);

  if (!isSafeBasename(pkg.file)) {
    throw new Error(`Unsafe or invalid package basename in manifest: ${pkg.file}`);
  }

  if (seenFiles.has(pkg.file)) {
    throw new Error(`Duplicate package filename in manifest: ${pkg.file}`);
  }
  seenFiles.add(pkg.file);

  if (typeof pkg.sha256 !== "string" || !/^[0-9a-f]{64}$/i.test(pkg.sha256)) {
    throw new Error(`Invalid sha256 checksum for package ${pkg.name}: ${pkg.sha256}`);
  }
}

export function validateManifest(manifest, options = {}) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("Manifest must be a non-null object");
  }

  if (manifest.format !== 1) {
    throw new Error(`Invalid manifest format: ${manifest.format}, expected 1`);
  }

  if (typeof manifest.commit !== "string" || !/^[0-9a-f]{40}$/i.test(manifest.commit)) {
    throw new Error(`Invalid commit SHA in manifest: ${manifest.commit}`);
  }
  if (
    options.expectedCommit &&
    manifest.commit.toLowerCase() !== options.expectedCommit.toLowerCase()
  ) {
    throw new Error(
      `Manifest commit ${manifest.commit} does not match expected ${options.expectedCommit}`,
    );
  }

  if (typeof manifest.version !== "string" || !manifest.version.trim()) {
    throw new Error(`Invalid version in manifest: ${manifest.version}`);
  }
  if (options.expectedVersion && manifest.version !== options.expectedVersion) {
    throw new Error(
      `Manifest version ${manifest.version} does not match expected ${options.expectedVersion}`,
    );
  }

  if (!Array.isArray(manifest.packages)) {
    throw new Error("Manifest packages must be an array");
  }

  if (manifest.packages.length !== EXPECTED_PACKAGES.length) {
    throw new Error(
      `Manifest packages count mismatch: found ${manifest.packages.length}, expected ${EXPECTED_PACKAGES.length}`,
    );
  }

  const packageNames = new Set();
  const seenFiles = new Set();

  for (const pkg of manifest.packages) {
    validateManifestPackage(pkg, packageNames, seenFiles);
  }

  for (const expected of EXPECTED_PACKAGES) {
    if (!packageNames.has(expected)) {
      throw new Error(`Missing expected package in manifest: ${expected}`);
    }
  }

  return true;
}

export function generateManifest({ commit, version, packages }) {
  const manifest = {
    format: 1,
    commit: commit.toLowerCase(),
    version,
    packages,
  };
  validateManifest(manifest);
  return manifest;
}

export function verifyDaemonArtifacts(outputDir, options = {}) {
  const resolvedDir = path.resolve(outputDir);
  if (!fs.existsSync(resolvedDir)) {
    throw new Error(`Daemon output directory does not exist: ${resolvedDir}`);
  }

  const entries = fs.readdirSync(resolvedDir);
  const manifestPath = path.join(resolvedDir, "manifest.json");

  if (!entries.includes("manifest.json")) {
    throw new Error(`Missing manifest.json in daemon directory: ${resolvedDir}`);
  }

  const manifestRaw = fs.readFileSync(manifestPath, "utf8");
  let manifest;
  try {
    manifest = JSON.parse(manifestRaw);
  } catch (error) {
    throw new Error(`Failed to parse manifest.json: ${error.message}`, { cause: error });
  }

  validateManifest(manifest, options);

  const expectedFiles = new Set(["manifest.json"]);
  for (const pkg of manifest.packages) {
    expectedFiles.add(pkg.file);
    const tarballPath = path.join(resolvedDir, pkg.file);
    if (!fs.existsSync(tarballPath)) {
      throw new Error(`Tarball for ${pkg.name} missing from directory: ${pkg.file}`);
    }

    const actualSha = computeSha256(tarballPath);
    if (actualSha.toLowerCase() !== pkg.sha256.toLowerCase()) {
      throw new Error(
        `Checksum mismatch for ${pkg.file}: expected ${pkg.sha256}, got ${actualSha}`,
      );
    }

    if (pkg.name === "@getpaseo/server") {
      if (!tarpackIncludesWebEntry(tarballPath)) {
        throw new Error(
          `Server tarball ${pkg.file} does not contain web entry (${EXPECTED_SERVER_WEB_ENTRY})`,
        );
      }
    }
  }

  const unexpectedFiles = entries.filter((file) => !expectedFiles.has(file));
  if (unexpectedFiles.length > 0) {
    throw new Error(
      `Daemon output directory contains unexpected files (expected only 7 tarballs + manifest.json): ${unexpectedFiles.join(", ")}`,
    );
  }

  return manifest;
}

export function defaultPackWorkspace(workspace, outputDir, repoRoot) {
  const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
  const result = spawnSync(
    npmCmd,
    ["pack", `--workspace=${workspace}`, `--pack-destination=${outputDir}`, "--ignore-scripts"],
    {
      cwd: repoRoot,
      encoding: "utf8",
      shell: process.platform === "win32",
    },
  );

  if (result.status !== 0) {
    throw new Error(
      `Failed to pack ${workspace}: exit code ${result.status}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
    );
  }

  const lines = result.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const tarballName = lines.find((line) => line.endsWith(".tgz"));
  if (!tarballName) {
    throw new Error(
      `npm pack did not return expected tarball filename for ${workspace}. Output: ${result.stdout}`,
    );
  }
  return path.basename(tarballName);
}

function resolveAndValidateTarball(workspace, tarballBasename, resolvedOutputDir) {
  if (!isSafeBasename(tarballBasename)) {
    throw new Error(`Packed tarball for ${workspace} has unsafe basename: ${tarballBasename}`);
  }

  const tarballPath = path.join(resolvedOutputDir, tarballBasename);
  if (!fs.existsSync(tarballPath)) {
    throw new Error(`Packed tarball file does not exist: ${tarballPath}`);
  }

  if (workspace === "@getpaseo/server" && !tarpackIncludesWebEntry(tarballPath)) {
    throw new Error(
      `Server tarball ${tarballBasename} does not contain web entry (${EXPECTED_SERVER_WEB_ENTRY}). Did build:daemon-web-ui run?`,
    );
  }

  return {
    name: workspace,
    file: tarballBasename,
    sha256: computeSha256(tarballPath),
  };
}

export function packDaemonArtifacts({
  repoRoot = path.resolve(import.meta.dirname, ".."),
  outputDir = path.join(repoRoot, "personal-artifacts", "daemon"),
  commit,
  version,
  packWorkspace = defaultPackWorkspace,
  skipPrereqCheck = false,
} = {}) {
  const rootPkgPath = path.join(repoRoot, "package.json");
  if (!fs.existsSync(rootPkgPath)) {
    throw new Error(`Cannot locate root package.json at ${rootPkgPath}`);
  }
  const rootPkg = JSON.parse(fs.readFileSync(rootPkgPath, "utf8"));
  const resolvedVersion = version || rootPkg.version;

  let resolvedCommit = commit;
  if (!resolvedCommit) {
    if (process.env.GITHUB_SHA && /^[0-9a-f]{40}$/i.test(process.env.GITHUB_SHA)) {
      resolvedCommit = process.env.GITHUB_SHA;
    } else {
      const gitResult = spawnSync("git", ["rev-parse", "HEAD"], {
        cwd: repoRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      const gitSha = gitResult.stdout?.trim();
      if (gitSha && /^[0-9a-f]{40}$/i.test(gitSha)) {
        resolvedCommit = gitSha;
      }
    }
  }

  if (!resolvedCommit || !/^[0-9a-f]{40}$/i.test(resolvedCommit)) {
    throw new Error(`Invalid or missing commit SHA: ${resolvedCommit}`);
  }
  resolvedCommit = resolvedCommit.toLowerCase();

  if (!skipPrereqCheck) {
    checkBuildPrerequisites(repoRoot);
  }

  const resolvedOutputDir = path.resolve(outputDir);
  if (fs.existsSync(resolvedOutputDir)) {
    fs.rmSync(resolvedOutputDir, { recursive: true, force: true });
  }
  fs.mkdirSync(resolvedOutputDir, { recursive: true });

  const packages = [];

  for (const workspace of EXPECTED_PACKAGES) {
    const tarballBasename = packWorkspace(workspace, resolvedOutputDir, repoRoot);
    packages.push(resolveAndValidateTarball(workspace, tarballBasename, resolvedOutputDir));
  }

  const manifest = generateManifest({
    commit: resolvedCommit,
    version: resolvedVersion,
    packages,
  });

  const manifestPath = path.join(resolvedOutputDir, "manifest.json");
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  verifyDaemonArtifacts(resolvedOutputDir, {
    expectedCommit: resolvedCommit,
    expectedVersion: resolvedVersion,
  });

  return { manifest, outputDir: resolvedOutputDir };
}

function parseCliArgs(argv) {
  const args = {
    action: "pack",
    outputDir: "personal-artifacts/daemon",
    commit: null,
    skipPrereqs: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "pack") {
      args.action = "pack";
    } else if (arg === "verify") {
      args.action = "verify";
    } else if (arg === "check-prereqs") {
      args.action = "check-prereqs";
    } else if (arg === "--output-dir" || arg === "-o") {
      args.outputDir = argv[++i];
    } else if (arg === "--commit" || arg === "-c") {
      args.commit = argv[++i];
    } else if (arg === "--skip-prereqs") {
      args.skipPrereqs = true;
    }
  }

  return args;
}

if (isMainModule(import.meta.url)) {
  const repoRoot = path.resolve(import.meta.dirname, "..");
  const args = parseCliArgs(process.argv.slice(2));

  try {
    if (args.action === "check-prereqs") {
      checkBuildPrerequisites(repoRoot);
      console.log("All build prerequisites are satisfied.");
    } else if (args.action === "verify") {
      const manifest = verifyDaemonArtifacts(args.outputDir, {
        expectedCommit: args.commit,
      });
      console.log(
        `Daemon artifacts verified successfully. Version: ${manifest.version}, Commit: ${manifest.commit}`,
      );
    } else {
      const { manifest, outputDir } = packDaemonArtifacts({
        repoRoot,
        outputDir: args.outputDir,
        commit: args.commit,
        skipPrereqCheck: args.skipPrereqs,
      });
      console.log(
        `Successfully packed ${manifest.packages.length} daemon artifacts into ${outputDir}`,
      );
      console.log(`Manifest created: version=${manifest.version}, commit=${manifest.commit}`);
    }
  } catch (error) {
    console.error(`personal-artifacts error: ${error.message}`);
    process.exit(1);
  }
}
