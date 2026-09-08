import { describe, expect, test } from "vitest";

import { buildPiLaunch, sanitizePiReadOnlyExtraArgs } from "./runtime.js";

describe("Pi launch policy", () => {
  test("enforces readOnly launch policy with confined tools, disabled ambient discovery, and trusted extension", () => {
    const launch = buildPiLaunch({
      command: ["pi"],
      session: {
        cwd: "/workspace/project",
        readOnly: true,
        mcpConfigPath: "/tmp/untrusted-mcp.json",
        extensionPaths: ["/tmp/trusted-paseo-extension.mjs"],
      },
    });

    expect(launch.readOnly).toBe(true);
    expect(launch.argv).toEqual([
      "pi",
      "--mode",
      "rpc",
      "--tools",
      "read,grep,find,ls",
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "--no-context-files",
      "--extension",
      "/tmp/trusted-paseo-extension.mjs",
    ]);
    expect(launch.argv).not.toContain("--mcp-config");
    expect(launch.argv).not.toContain("/tmp/untrusted-mcp.json");
  });

  test("filters mutating tools from requested tools in readOnly mode", () => {
    const launch = buildPiLaunch({
      command: ["pi"],
      session: {
        cwd: "/workspace/project",
        readOnly: true,
        tools: [
          "read",
          "bash",
          "grep",
          "write",
          "find",
          "edit",
          "ls",
          "powershell",
          "vetted_host_tool",
        ],
      },
    });

    const toolsFlagIndex = launch.argv.indexOf("--tools");
    expect(toolsFlagIndex).toBeGreaterThan(-1);
    const toolsValue = launch.argv[toolsFlagIndex + 1];
    expect(toolsValue).toBe("read,grep,find,ls,vetted_host_tool");
    expect(toolsValue).not.toContain("bash");
    expect(toolsValue).not.toContain("write");
    expect(toolsValue).not.toContain("edit");
    expect(toolsValue).not.toContain("powershell");
  });

  test("sanitizes untrusted extraArgs in readOnly mode, stripping dangerous tool and extension flags", () => {
    const dangerousExtraArgs = [
      "--tools",
      "bash,write",
      "-t",
      "powershell",
      "--exclude-tools",
      "read",
      "-xt",
      "read",
      "--extension",
      "/tmp/evil-ext.js",
      "-e",
      "/tmp/other.js",
      "--skill",
      "/tmp/skill",
      "--prompt-template",
      "/tmp/pt",
      "--mcp-config",
      "/tmp/mcp.json",
      "--mode",
      "interactive",
      "--no-context-files",
      "--safe-flag",
      "safe-value",
    ];

    const sanitized = sanitizePiReadOnlyExtraArgs(dangerousExtraArgs);
    expect(sanitized).toEqual(["--safe-flag", "safe-value"]);

    const launch = buildPiLaunch({
      command: ["pi"],
      session: {
        cwd: "/workspace/project",
        readOnly: true,
        extraArgs: dangerousExtraArgs,
      },
    });

    expect(launch.argv).toContain("--safe-flag");
    expect(launch.argv).toContain("safe-value");
    expect(launch.argv).not.toContain("bash,write");
    expect(launch.argv).not.toContain("/tmp/evil-ext.js");
    expect(launch.argv).not.toContain("/tmp/mcp.json");
  });

  test("sanitizes command arguments beyond binary in readOnly mode", () => {
    const launch = buildPiLaunch({
      command: ["pi", "--extension", "/tmp/inherited.js", "--tools", "write"],
      session: {
        cwd: "/workspace/project",
        readOnly: true,
      },
    });

    expect(launch.argv[0]).toBe("pi");
    expect(launch.argv).not.toContain("/tmp/inherited.js");
    expect(launch.argv).not.toContain("write");
    expect(launch.argv).toEqual(
      expect.arrayContaining(["--tools", "read,grep,find,ls", "--no-extensions"]),
    );
  });

  test("preserves default non-readOnly behavior and forwards mcpConfigPath and extraArgs", () => {
    const launch = buildPiLaunch({
      command: ["pi"],
      session: {
        cwd: "/workspace/project",
        mcpConfigPath: "/tmp/mcp.json",
        extensionPaths: ["/tmp/my-ext.js"],
        extraArgs: ["--custom-arg", "123"],
      },
    });

    expect(launch.readOnly).toBeUndefined();
    expect(launch.argv).toEqual([
      "pi",
      "--mode",
      "rpc",
      "--custom-arg",
      "123",
      "--mcp-config",
      "/tmp/mcp.json",
      "--extension",
      "/tmp/my-ext.js",
    ]);
    expect(launch.argv).not.toContain("--no-extensions");
    expect(launch.argv).not.toContain("--no-skills");
  });
});
