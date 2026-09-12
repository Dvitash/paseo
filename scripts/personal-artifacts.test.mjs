import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import zlib from "node:zlib";
import {
  EXPECTED_PACKAGES,
  EXPECTED_SERVER_WEB_ENTRY,
  SUPPORTED_DESKTOP_TARGETS,
  checkBuildPrerequisites,
  isSafeBasename,
  packDaemonArtifacts,
  selectDesktopArtifacts,
  stageDesktopArtifacts,
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

test("SUPPORTED_DESKTOP_TARGETS and target validation: enforces supported desktop targets", () => {
  assert.deepEqual(
    [...SUPPORTED_DESKTOP_TARGETS],
    ["linux-arm64", "linux-x64", "macos-arm64", "windows-x64"],
  );

  withTempDir("paseo-target-val-test-", (tempDir) => {
    const releaseDir = path.join(tempDir, "release");
    fs.mkdirSync(releaseDir, { recursive: true });
    fs.writeFileSync(path.join(releaseDir, "Paseo-Setup-0.8.0-beta.1-x64.exe"), "installer");

    assert.throws(
      () => selectDesktopArtifacts(releaseDir, "darwin-x64"),
      /Unsupported desktop target: darwin-x64/,
    );
    assert.throws(
      () => selectDesktopArtifacts(releaseDir, "android"),
      /Unsupported desktop target: android/,
    );
    assert.throws(() => selectDesktopArtifacts(releaseDir, ""), /Desktop target must be specified/);
    assert.throws(
      () => stageDesktopArtifacts({ releaseDir, target: "invalid-target" }),
      /Unsupported desktop target: invalid-target/,
    );
  });
});

test("selectDesktopArtifacts and stageDesktopArtifacts: handles actual 5-file Windows layout selecting only x64 exe", () => {
  withTempDir("paseo-win-5file-test-", (tempDir) => {
    const releaseDir = path.join(tempDir, "release");
    const outputDir = path.join(tempDir, "output");
    fs.mkdirSync(releaseDir, { recursive: true });

    // 5-file artifact layout from personal update run 34281333436
    const fiveFiles = [
      "Paseo-Setup-0.8.0-beta.1-arm64.exe",
      "Paseo-Setup-0.8.0-beta.1-arm64.zip",
      "Paseo-Setup-0.8.0-beta.1-x64.exe",
      "Paseo-Setup-0.8.0-beta.1-x64.zip",
      "Paseo-Setup-0.8.0-beta.1.exe",
    ];

    for (const filename of fiveFiles) {
      fs.writeFileSync(path.join(releaseDir, filename), `dummy-content-for-${filename}`);
    }

    // Extraneous subdirectories and builder configs that electron-builder outputs
    const winUnpacked = path.join(releaseDir, "win-unpacked");
    fs.mkdirSync(winUnpacked, { recursive: true });
    fs.writeFileSync(path.join(winUnpacked, "Paseo.exe"), "unpacked binary");
    fs.writeFileSync(path.join(releaseDir, "builder-effective-config.yaml"), "config: true");

    const selected = selectDesktopArtifacts(releaseDir, "windows-x64");
    assert.deepEqual(selected, ["Paseo-Setup-0.8.0-beta.1-x64.exe"]);

    const result = stageDesktopArtifacts({
      releaseDir,
      outputDir,
      target: "windows-x64",
    });

    assert.equal(result.target, "windows-x64");
    assert.deepEqual(result.files, ["Paseo-Setup-0.8.0-beta.1-x64.exe"]);

    // Output directory must contain strictly 1 file
    const stagedFiles = fs.readdirSync(outputDir);
    assert.equal(stagedFiles.length, 1);
    assert.equal(stagedFiles[0], "Paseo-Setup-0.8.0-beta.1-x64.exe");
    assert.equal(
      fs.readFileSync(path.join(outputDir, "Paseo-Setup-0.8.0-beta.1-x64.exe"), "utf8"),
      "dummy-content-for-Paseo-Setup-0.8.0-beta.1-x64.exe",
    );
  });
});

test("selectDesktopArtifacts: rejects missing or ambiguous Windows installer and excludes directories", () => {
  withTempDir("paseo-win-rejections-test-", (tempDir) => {
    const releaseDir = path.join(tempDir, "release");
    fs.mkdirSync(releaseDir, { recursive: true });

    // Empty directory rejection
    assert.throws(
      () => selectDesktopArtifacts(releaseDir, "windows-x64"),
      /No Windows x64 installer matching Paseo-Setup-\*-x64\.exe found/,
    );

    // Non-matching files (arm64 exe, combined exe, zips) rejection
    fs.writeFileSync(path.join(releaseDir, "Paseo-Setup-0.8.0-beta.1-arm64.exe"), "arm64");
    fs.writeFileSync(path.join(releaseDir, "Paseo-Setup-0.8.0-beta.1.exe"), "legacy");
    fs.writeFileSync(path.join(releaseDir, "Paseo-Setup-0.8.0-beta.1-x64.zip"), "zip");
    assert.throws(
      () => selectDesktopArtifacts(releaseDir, "windows-x64"),
      /No Windows x64 installer matching Paseo-Setup-\*-x64\.exe found/,
    );

    // Directory with matching name is excluded and does not satisfy installer requirement
    const dirMatchingName = path.join(releaseDir, "Paseo-Setup-0.8.0-beta.1-x64.exe");
    fs.mkdirSync(dirMatchingName, { recursive: true });
    assert.throws(
      () => selectDesktopArtifacts(releaseDir, "windows-x64"),
      /No Windows x64 installer matching Paseo-Setup-\*-x64\.exe found/,
    );
    fs.rmSync(dirMatchingName, { recursive: true });

    // Ambiguous installer rejection (multiple x64 installers)
    fs.writeFileSync(path.join(releaseDir, "Paseo-Setup-0.8.0-beta.1-x64.exe"), "v1");
    fs.writeFileSync(path.join(releaseDir, "Paseo-Setup-0.8.0-beta.2-x64.exe"), "v2");
    assert.throws(
      () => selectDesktopArtifacts(releaseDir, "windows-x64"),
      /Expected exactly 1 Windows x64 installer matching Paseo-Setup-\*-x64\.exe, found 2/,
    );
  });
});

test("selectDesktopArtifacts and stageDesktopArtifacts: preserves non-Windows behavior including .exe", () => {
  withTempDir("paseo-non-windows-test-", (tempDir) => {
    // Test macos-arm64: preserves original extension set including .exe
    const macRelease = path.join(tempDir, "mac-release");
    const macOutput = path.join(tempDir, "mac-output");
    fs.mkdirSync(macRelease, { recursive: true });

    fs.writeFileSync(path.join(macRelease, "Paseo-0.8.0-arm64.dmg"), "dmg");
    fs.writeFileSync(path.join(macRelease, "Paseo-0.8.0-arm64.zip"), "zip");
    fs.writeFileSync(path.join(macRelease, "helper-utility.exe"), "exe");
    fs.writeFileSync(path.join(macRelease, "latest-mac.yml"), "yml");
    const macSubDir = path.join(macRelease, "mac");
    fs.mkdirSync(macSubDir, { recursive: true });
    fs.writeFileSync(path.join(macSubDir, "app"), "nested");

    const macResult = stageDesktopArtifacts({
      releaseDir: macRelease,
      outputDir: macOutput,
      target: "macos-arm64",
    });
    assert.deepEqual(macResult.files, [
      "Paseo-0.8.0-arm64.dmg",
      "Paseo-0.8.0-arm64.zip",
      "helper-utility.exe",
    ]);
    assert.deepEqual(fs.readdirSync(macOutput).sort(), [
      "Paseo-0.8.0-arm64.dmg",
      "Paseo-0.8.0-arm64.zip",
      "helper-utility.exe",
    ]);

    // Test linux-x64
    const linuxRelease = path.join(tempDir, "linux-release");
    const linuxOutput = path.join(tempDir, "linux-output");
    fs.mkdirSync(linuxRelease, { recursive: true });

    fs.writeFileSync(path.join(linuxRelease, "Paseo-x86_64.AppImage"), "appimage");
    fs.writeFileSync(path.join(linuxRelease, "Paseo-0.8.0-x64.tar.gz"), "targz");
    fs.writeFileSync(path.join(linuxRelease, "paseo_0.8.0_amd64.deb"), "deb");
    fs.writeFileSync(path.join(linuxRelease, "paseo-0.8.0.x86_64.rpm"), "rpm");
    const linuxSubDir = path.join(linuxRelease, "linux-unpacked");
    fs.mkdirSync(linuxSubDir, { recursive: true });

    const linuxResult = stageDesktopArtifacts({
      releaseDir: linuxRelease,
      outputDir: linuxOutput,
      target: "linux-x64",
    });
    assert.deepEqual(linuxResult.files, [
      "Paseo-0.8.0-x64.tar.gz",
      "Paseo-x86_64.AppImage",
      "paseo-0.8.0.x86_64.rpm",
      "paseo_0.8.0_amd64.deb",
    ]);

    // Non-Windows with no installable archives throws
    const emptyRelease = path.join(tempDir, "empty-release");
    fs.mkdirSync(emptyRelease, { recursive: true });
    fs.writeFileSync(path.join(emptyRelease, "config.yaml"), "config");
    assert.throws(
      () => selectDesktopArtifacts(emptyRelease, "linux-x64"),
      /No installable archives found in/,
    );
  });
});

test("stageDesktopArtifacts: safety regressions proving rejection leaves source and output unchanged", () => {
  withTempDir("paseo-safety-regression-test-", (tempDir) => {
    const releaseDir = path.join(tempDir, "release");
    fs.mkdirSync(releaseDir, { recursive: true });
    const installerFile = path.join(releaseDir, "Paseo-Setup-0.8.0-beta.1-x64.exe");
    fs.writeFileSync(installerFile, "precious-source-installer");

    // Safety check 1: non-empty outputDir is rejected and NEVER erased
    const existingOutputDir = path.join(tempDir, "existing-output");
    fs.mkdirSync(existingOutputDir, { recursive: true });
    const userFile = path.join(existingOutputDir, "user-important-data.txt");
    fs.writeFileSync(userFile, "cannot-be-deleted");

    assert.throws(
      () =>
        stageDesktopArtifacts({
          releaseDir,
          outputDir: existingOutputDir,
          target: "windows-x64",
        }),
      /Output directory must be empty, found 1 item\(s\)/,
    );

    // Prove output directory contents were not deleted or modified
    assert.equal(fs.existsSync(userFile), true);
    assert.equal(fs.readFileSync(userFile, "utf8"), "cannot-be-deleted");
    assert.equal(fs.readdirSync(existingOutputDir).length, 1);
    // Prove release directory was not modified
    assert.equal(fs.readFileSync(installerFile, "utf8"), "precious-source-installer");

    // Safety check 2: outputDir same as releaseDir is rejected without mutation
    assert.throws(
      () =>
        stageDesktopArtifacts({
          releaseDir,
          outputDir: releaseDir,
          target: "windows-x64",
        }),
      /Output directory cannot be the same as release directory/,
    );
    assert.equal(fs.readFileSync(installerFile, "utf8"), "precious-source-installer");

    // Safety check 3: outputDir as ancestor or inside releaseDir is rejected without mutation
    assert.throws(
      () =>
        stageDesktopArtifacts({
          releaseDir,
          outputDir: tempDir, // ancestor of releaseDir
          target: "windows-x64",
        }),
      /Output directory cannot be an ancestor of release directory/,
    );

    const nestedOutputDir = path.join(releaseDir, "nested-output");
    assert.throws(
      () =>
        stageDesktopArtifacts({
          releaseDir,
          outputDir: nestedOutputDir,
          target: "windows-x64",
        }),
      /Output directory cannot be inside release directory/,
    );
    assert.equal(fs.existsSync(nestedOutputDir), false); // not created

    // Safety check 4: selection failure does not create output directory
    const emptyReleaseDir = path.join(tempDir, "empty-release");
    fs.mkdirSync(emptyReleaseDir, { recursive: true });
    const nonExistentOutputDir = path.join(tempDir, "not-yet-created-output");

    assert.throws(
      () =>
        stageDesktopArtifacts({
          releaseDir: emptyReleaseDir,
          outputDir: nonExistentOutputDir,
          target: "windows-x64",
        }),
      /No Windows x64 installer matching Paseo-Setup-\*-x64\.exe found/,
    );
    assert.equal(fs.existsSync(nonExistentOutputDir), false); // outputDir was never created
  });
});

test("CLI stage-desktop: stages Windows artifact end-to-end and rejects non-empty outputDir", () => {
  withTempDir("paseo-cli-stage-test-", (tempDir) => {
    const releaseDir = path.join(tempDir, "release");
    const outputDir = path.join(tempDir, "output");
    fs.mkdirSync(releaseDir, { recursive: true });

    fs.writeFileSync(
      path.join(releaseDir, "Paseo-Setup-0.8.0-beta.1-x64.exe"),
      "windows x64 installer",
    );
    fs.writeFileSync(
      path.join(releaseDir, "Paseo-Setup-0.8.0-beta.1-arm64.exe"),
      "arm64 installer",
    );

    const scriptPath = path.resolve(import.meta.dirname, "personal-artifacts.mjs");

    // Successful run with empty outputDir
    const result = spawnSync(
      process.execPath,
      [
        scriptPath,
        "stage-desktop",
        "--target",
        "windows-x64",
        "--release-dir",
        releaseDir,
        "--output-dir",
        outputDir,
      ],
      { encoding: "utf8" },
    );

    assert.equal(result.status, 0, `CLI failed with: ${result.stderr}`);
    assert.match(result.stdout, /Staging archive: Paseo-Setup-0.8.0-beta.1-x64.exe/);
    assert.match(result.stdout, /Successfully staged 1 desktop archive\(s\)/);

    const files = fs.readdirSync(outputDir);
    assert.deepEqual(files, ["Paseo-Setup-0.8.0-beta.1-x64.exe"]);

    // Re-running without clearing outputDir fails because outputDir is non-empty
    const failResult = spawnSync(
      process.execPath,
      [
        scriptPath,
        "stage-desktop",
        "--target",
        "windows-x64",
        "--release-dir",
        releaseDir,
        "--output-dir",
        outputDir,
      ],
      { encoding: "utf8" },
    );

    assert.equal(failResult.status, 1);
    assert.match(failResult.stderr, /Output directory must be empty/);
  });
});
