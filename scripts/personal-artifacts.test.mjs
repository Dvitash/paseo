import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import zlib from "node:zlib";
import {
  EXPECTED_PACKAGES,
  EXPECTED_SERVER_WEB_ENTRY,
  checkBuildPrerequisites,
  isSafeBasename,
  packDaemonArtifacts,
  tarpackIncludesWebEntry,
  validateManifest,
  verifyDaemonArtifacts,
} from "./personal-artifacts.mjs";

function createMockTarGz(files) {
  const chunks = [];
  for (const file of files) {
    const content = Buffer.isBuffer(file.content) ? file.content : Buffer.from(file.content || "");
    const header = Buffer.alloc(512);

    header.write(file.name, 0, 100, "utf8");
    header.write("0000644\0", 100, 8, "utf8");
    header.write("0000000\0", 108, 8, "utf8");
    header.write("0000000\0", 116, 8, "utf8");
    const sizeOctal =
      file.type === "5" ? "00000000000\0" : `${content.length.toString(8).padStart(11, "0")}\0`;
    header.write(sizeOctal, 124, 12, "utf8");
    header.write("00000000000\0", 136, 12, "utf8");
    header.fill(32, 148, 156);
    header[156] = (file.type || "0").charCodeAt(0);
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

function withTempDir(prefix, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const VALID_COMMIT = "abcdef0123456789abcdef0123456789abcdef01";
const VALID_VERSION = "0.8.0-beta.1";
const DUMMY_SHA = "1111111111111111111111111111111111111111111111111111111111111111";

function createValidPackageList() {
  return EXPECTED_PACKAGES.map((name) => {
    const safeName = name.replace("@", "").replace("/", "-");
    return {
      name,
      file: `${safeName}-${VALID_VERSION}.tgz`,
      sha256: DUMMY_SHA,
    };
  });
}

test("isSafeBasename: enforces safe filenames and rejects traversal", () => {
  assert.equal(isSafeBasename("getpaseo-server-0.8.0.tgz"), true);
  assert.equal(isSafeBasename("getpaseo-cli-1.0.0-beta.1.tgz"), true);
  assert.equal(isSafeBasename("package.tar.gz"), true);

  assert.equal(isSafeBasename("../getpaseo-server.tgz"), false);
  assert.equal(isSafeBasename("sub/getpaseo-server.tgz"), false);
  assert.equal(isSafeBasename("/tmp/getpaseo-server.tgz"), false);
  assert.equal(isSafeBasename("C:\\getpaseo-server.tgz"), false);
  assert.equal(isSafeBasename("getpaseo-server.zip"), false);
  assert.equal(isSafeBasename(""), false);
  assert.equal(isSafeBasename("   "), false);
  assert.equal(isSafeBasename(null), false);
  assert.equal(isSafeBasename(undefined), false);
});

test("validateManifest: accepts well-formed manifest with exact package set", () => {
  const manifest = {
    format: 1,
    commit: VALID_COMMIT,
    version: VALID_VERSION,
    packages: createValidPackageList(),
  };

  assert.equal(
    validateManifest(manifest, {
      expectedCommit: VALID_COMMIT,
      expectedVersion: VALID_VERSION,
    }),
    true,
  );
});

test("validateManifest: rejects invalid format, commit, or version metadata", () => {
  const base = () => ({
    format: 1,
    commit: VALID_COMMIT,
    version: VALID_VERSION,
    packages: createValidPackageList(),
  });

  assert.throws(() => validateManifest({ ...base(), format: 2 }), /Invalid manifest format: 2/);
  assert.throws(() => validateManifest({ ...base(), commit: "not-a-sha" }), /Invalid commit SHA/);
  assert.throws(() => validateManifest({ ...base(), commit: "abc" }), /Invalid commit SHA/);
  assert.throws(() => validateManifest({ ...base(), version: "" }), /Invalid version/);
  assert.throws(
    () => validateManifest(base(), { expectedCommit: "1111111111111111111111111111111111111111" }),
    /does not match expected/,
  );
});

test("validateManifest: enforces exact expected package set", () => {
  const packagesWithoutCli = createValidPackageList().filter((p) => p.name !== "@getpaseo/cli");
  assert.throws(
    () =>
      validateManifest({
        format: 1,
        commit: VALID_COMMIT,
        version: VALID_VERSION,
        packages: packagesWithoutCli,
      }),
    /Manifest packages count mismatch/,
  );

  const packagesWithExtra = [
    ...createValidPackageList(),
    { name: "@getpaseo/desktop", file: "getpaseo-desktop.tgz", sha256: DUMMY_SHA },
  ];
  assert.throws(
    () =>
      validateManifest({
        format: 1,
        commit: VALID_COMMIT,
        version: VALID_VERSION,
        packages: packagesWithExtra,
      }),
    /Manifest packages count mismatch/,
  );

  const packagesWithDuplicate = createValidPackageList();
  packagesWithDuplicate[0] = { ...packagesWithDuplicate[1] };
  assert.throws(
    () =>
      validateManifest({
        format: 1,
        commit: VALID_COMMIT,
        version: VALID_VERSION,
        packages: packagesWithDuplicate,
      }),
    /Duplicate package name/,
  );
});

test("validateManifest: rejects unsafe package filename or invalid sha256", () => {
  const packagesUnsafeFile = createValidPackageList();
  packagesUnsafeFile[0].file = "../escaped.tgz";
  assert.throws(
    () =>
      validateManifest({
        format: 1,
        commit: VALID_COMMIT,
        version: VALID_VERSION,
        packages: packagesUnsafeFile,
      }),
    /Unsafe or invalid package basename/,
  );

  const packagesBadSha = createValidPackageList();
  packagesBadSha[0].sha256 = "not-a-sha256";
  assert.throws(
    () =>
      validateManifest({
        format: 1,
        commit: VALID_COMMIT,
        version: VALID_VERSION,
        packages: packagesBadSha,
      }),
    /Invalid sha256 checksum/,
  );
});

test("checkBuildPrerequisites: reports missing build files with remedy instructions", () => {
  withTempDir("paseo-prereqs-test-", (mockRepo) => {
    assert.throws(
      () => checkBuildPrerequisites(mockRepo),
      (err) => {
        assert.match(err.message, /Build prerequisites check failed/);
        assert.match(err.message, /npm run build:daemon-web-ui/);
        assert.match(err.message, /npm run build:server/);
        return true;
      },
    );

    // Create all required paths
    const requiredRelativePaths = [
      "packages/server/dist/server/web-ui/index.html",
      "packages/server/dist/scripts/supervisor-entrypoint.js",
      "packages/cli/dist/index.js",
      "packages/client/dist",
      "packages/protocol/dist",
      "packages/relay/dist",
      "packages/highlight/dist",
      "packages/plugin/dist",
    ];

    for (const rel of requiredRelativePaths) {
      const full = path.join(mockRepo, rel);
      if (rel.endsWith(".html") || rel.endsWith(".js")) {
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, "export default {};");
      } else {
        fs.mkdirSync(full, { recursive: true });
      }
    }

    assert.equal(checkBuildPrerequisites(mockRepo), true);
  });
});

test("tarpackIncludesWebEntry: checks presence of web entry in tarball", () => {
  const tgzWithWeb = createMockTarGz([
    { name: "package/package.json", content: '{"name":"@getpaseo/server"}' },
    {
      name: EXPECTED_SERVER_WEB_ENTRY,
      content: "<!DOCTYPE html><html><body>Paseo Web</body></html>",
    },
  ]);

  const tgzWithoutWeb = createMockTarGz([
    { name: "package/package.json", content: '{"name":"@getpaseo/server"}' },
    { name: "package/dist/server/index.js", content: "console.log('server');" },
  ]);

  assert.equal(tarpackIncludesWebEntry(tgzWithWeb), true);
  assert.equal(tarpackIncludesWebEntry(tgzWithoutWeb), false);
});

test("packDaemonArtifacts and verifyDaemonArtifacts: deterministic end-to-end packing", () => {
  withTempDir("paseo-pack-test-", (tempDir) => {
    const mockRepo = path.join(tempDir, "repo");
    fs.mkdirSync(mockRepo, { recursive: true });
    fs.writeFileSync(
      path.join(mockRepo, "package.json"),
      JSON.stringify({ name: "paseo", version: VALID_VERSION }),
    );

    const outputDir = path.join(tempDir, "artifacts", "daemon");

    const mockPackWorkspace = (workspace, destDir) => {
      const safeName = workspace.replace("@", "").replace("/", "-");
      const filename = `${safeName}-${VALID_VERSION}.tgz`;
      const isServer = workspace === "@getpaseo/server";

      const files = [
        {
          name: "package/package.json",
          content: JSON.stringify({ name: workspace, version: VALID_VERSION }),
        },
      ];
      if (isServer) {
        files.push({
          name: EXPECTED_SERVER_WEB_ENTRY,
          content: "<!DOCTYPE html><html><body>Web UI</body></html>",
        });
      }

      const tgzBuffer = createMockTarGz(files);
      fs.writeFileSync(path.join(destDir, filename), tgzBuffer);
      return filename;
    };

    const result = packDaemonArtifacts({
      repoRoot: mockRepo,
      outputDir,
      commit: VALID_COMMIT,
      version: VALID_VERSION,
      packWorkspace: mockPackWorkspace,
      skipPrereqCheck: true,
    });

    assert.equal(result.manifest.format, 1);
    assert.equal(result.manifest.commit, VALID_COMMIT);
    assert.equal(result.manifest.version, VALID_VERSION);
    assert.equal(result.manifest.packages.length, 7);

    // Verify directory contains ONLY the 7 tarballs + manifest.json (exact 8 files)
    const files = fs.readdirSync(outputDir).sort();
    assert.equal(files.length, 8);
    assert.ok(files.includes("manifest.json"));

    // Running verification succeeds
    const verified = verifyDaemonArtifacts(outputDir, {
      expectedCommit: VALID_COMMIT,
      expectedVersion: VALID_VERSION,
    });
    assert.equal(verified.commit, VALID_COMMIT);

    // Verification fails if an unexpected file is added
    fs.writeFileSync(path.join(outputDir, "unexpected.txt"), "stray file");
    assert.throws(() => verifyDaemonArtifacts(outputDir), /contains unexpected files/);
    fs.rmSync(path.join(outputDir, "unexpected.txt"));

    // Verification fails if a tarball is corrupted or modified
    const serverTarballPath = path.join(outputDir, `getpaseo-server-${VALID_VERSION}.tgz`);
    fs.writeFileSync(serverTarballPath, "tampered content");
    assert.throws(() => verifyDaemonArtifacts(outputDir), /Checksum mismatch/);
  });
});
