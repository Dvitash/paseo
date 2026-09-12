import { describe, expect, test } from "vitest";

import { buildOmpLaunch, sanitizeOmpReadOnlyExtraArgs } from "./runtime.js";
import { OmpHarness } from "./test-utils/omp-harness.js";

test("falls back to progress when the event subscription is unavailable", async () => {
  const omp = new OmpHarness();
  omp.failEventSubscription(new Error("events unsupported"));
  await omp.start();

  await expect(omp.waitForSubscriptionFallback()).resolves.toEqual(["events", "progress"]);
});

describe("OMP launch policy", () => {
  test("enforces readOnly launch policy with confined tools, disabled ambient discovery, and config/extension paths", () => {
    const launch = buildOmpLaunch({
      command: ["omp"],
      session: {
        cwd: "/workspace/project",
        readOnly: true,
        configFilePath: "/tmp/readonly-config.yaml",
        extensionPaths: ["/tmp/readonly-guard.mjs"],
      },
    });

    expect(launch.readOnly).toBe(true);
    expect(launch.configFilePath).toBe("/tmp/readonly-config.yaml");
    expect(launch.extensionPaths).toEqual(["/tmp/readonly-guard.mjs"]);
    expect(launch.argv).toEqual([
      "omp",
      "--mode",
      "rpc",
      "--tools",
      "read,grep,glob",
      "--no-extensions",
      "--no-skills",
      "--no-rules",
      "--no-lsp",
      "--config",
      "/tmp/readonly-config.yaml",
      "--extension",
      "/tmp/readonly-guard.mjs",
    ]);
  });

  test("sanitizes untrusted extraArgs in readOnly mode, stripping dangerous tool, extension, and config flags", () => {
    const dangerousExtraArgs = [
      "--tools",
      "bash,write",
      "--extension",
      "/tmp/evil-ext.js",
      "-e",
      "/tmp/other.js",
      "--trusted-extension=/tmp/trusted.js",
      "--hook",
      "/tmp/hook.js",
      "--config",
      "/tmp/evil-config.yaml",
      "--plugin-dir",
      "/tmp/plugins",
      "--auto-approve",
      "--yolo",
      "--plan-yolo",
      "--safe-flag",
      "value",
    ];

    const sanitized = sanitizeOmpReadOnlyExtraArgs(dangerousExtraArgs);
    expect(sanitized).toEqual(["--safe-flag", "value"]);

    const launch = buildOmpLaunch({
      command: ["omp"],
      session: {
        cwd: "/workspace/project",
        readOnly: true,
        extraArgs: dangerousExtraArgs,
      },
    });

    expect(launch.argv).toContain("--safe-flag");
    expect(launch.argv).toContain("value");
    expect(launch.argv).not.toContain("bash,write");
    expect(launch.argv).not.toContain("/tmp/evil-ext.js");
    expect(launch.argv).not.toContain("/tmp/evil-config.yaml");
  });

  test("sanitizes command arguments beyond binary in readOnly mode", () => {
    const launch = buildOmpLaunch({
      command: ["omp", "--extension", "/tmp/inherited.js", "--tools", "write"],
      session: {
        cwd: "/workspace/project",
        readOnly: true,
      },
    });

    expect(launch.argv[0]).toBe("omp");
    expect(launch.argv).not.toContain("/tmp/inherited.js");
    expect(launch.argv).not.toContain("write");
    expect(launch.argv).toEqual(
      expect.arrayContaining(["--tools", "read,grep,glob", "--no-extensions"]),
    );
  });

  test("launches a forked session via --fork instead of --session/--no-session", () => {
    const launch = buildOmpLaunch({
      command: ["omp"],
      session: {
        cwd: "/workspace/project",
        fork: "/home/user/.omp/sessions/abc123.jsonl",
      },
    });

    expect(launch.fork).toBe("/home/user/.omp/sessions/abc123.jsonl");
    expect(launch.argv).toContain("--fork");
    expect(launch.argv).toContain("/home/user/.omp/sessions/abc123.jsonl");
    expect(launch.argv).not.toContain("--session");
    expect(launch.argv).not.toContain("--no-session");
  });

  test("fork carries the parent prompt-cache key explicitly", () => {
    const launch = buildOmpLaunch({
      command: ["omp"],
      session: {
        cwd: "/workspace/project",
        fork: "/home/user/.omp/sessions/abc123.jsonl",
        promptCacheKey: "parent-cache-key",
      },
    });

    expect(launch.argv).toEqual(
      expect.arrayContaining([
        "--fork",
        "/home/user/.omp/sessions/abc123.jsonl",
        "--prompt-cache-key",
        "parent-cache-key",
      ]),
    );
  });

  test("readOnly fork keeps confinement flags alongside --fork", () => {
    const launch = buildOmpLaunch({
      command: ["omp"],
      session: {
        cwd: "/workspace/project",
        readOnly: true,
        fork: "/home/user/.omp/sessions/abc123.jsonl",
        configFilePath: "/tmp/readonly-config.yaml",
        extensionPaths: ["/tmp/readonly-guard.mjs"],
      },
    });

    expect(launch.argv).toEqual(
      expect.arrayContaining([
        "--fork",
        "/home/user/.omp/sessions/abc123.jsonl",
        "--tools",
        "read,grep,glob",
        "--no-extensions",
        "--extension",
        "/tmp/readonly-guard.mjs",
      ]),
    );
    expect(launch.argv).not.toContain("--session");
  });

  test("preserves default non-readOnly behavior and passes extraArgs unchanged", () => {
    const launch = buildOmpLaunch({
      command: ["omp"],
      session: {
        cwd: "/workspace/project",
        extraArgs: ["--extension", "/custom/ext.js", "--tools", "all"],
      },
    });

    expect(launch.readOnly).toBeUndefined();
    expect(launch.argv).toEqual([
      "omp",
      "--mode",
      "rpc",
      "--extension",
      "/custom/ext.js",
      "--tools",
      "all",
    ]);
    expect(launch.argv).not.toContain("--no-extensions");
    expect(launch.argv).not.toContain("--no-skills");
  });
});
