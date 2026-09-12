import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { validateDesktopUrl } from "../shared/rpc";
import { findDesktopStateForCwd, findDesktopStateSummary } from "./state";

describe("validateDesktopUrl", () => {
  it.each(["https://spark.tailnet.ts.net:20109/", "http://127.0.0.1:18109/"])(
    "accepts %s without changing the advertised address",
    (url) => {
      expect(validateDesktopUrl(url)).toEqual({ ok: true, url });
    },
  );

  it("rejects embedded credentials without echoing them in the error", () => {
    expect(validateDesktopUrl("https://user:secret@spark.tailnet.ts.net:20109/")).toEqual({
      ok: false,
      message: "Desktop URL contains embedded credentials, which is prohibited.",
    });
  });

  it.each(["file:///etc/passwd", "javascript:alert(1)"])("rejects %s", (url) => {
    expect(validateDesktopUrl(url)).toEqual({
      ok: false,
      message: "Desktop URL must use HTTP or HTTPS protocol.",
    });
  });

  it("rejects malformed URLs", () => {
    expect(validateDesktopUrl("not-a-valid-url")).toEqual({
      ok: false,
      message: "Malformed desktop browser URL.",
    });
  });
});

describe("findDesktopStateForCwd", () => {
  let tempBaseDir: string;

  beforeEach(() => {
    tempBaseDir = mkdtempSync(join(tmpdir(), "spark-desktops-test-"));
  });

  afterEach(() => {
    rmSync(tempBaseDir, { recursive: true, force: true });
  });

  it("returns not_found when baseDir does not exist", () => {
    const result = findDesktopStateForCwd("/some/worktree", join(tempBaseDir, "nonexistent"));
    expect(result.kind).toBe("not_found");
  });

  it("returns not_found when no state matches worktree_path", () => {
    const deskDir = join(tempBaseDir, "wt-1");
    mkdirSync(deskDir, { recursive: true });
    writeFileSync(
      join(deskDir, "state.json"),
      JSON.stringify({
        display: 109,
        port: 48689,
        slug: "wt-1",
        worktree_path: "/different/path",
      }),
    );

    const result = findDesktopStateForCwd("/target/worktree", tempBaseDir);
    expect(result.kind).toBe("not_found");
  });

  it("returns found with validated state when matching cwd", () => {
    const targetCwd = "/home/user/worktrees/feature";
    const deskDir = join(tempBaseDir, "feature");
    mkdirSync(deskDir, { recursive: true });
    writeFileSync(
      join(deskDir, "state.json"),
      JSON.stringify({
        display: 105,
        port: 48685,
        slug: "feature",
        worktree_path: targetCwd,
        browser_enabled: true,
        browser_url: "https://spark.tailnet.ts.net:20105/",
      }),
    );

    const result = findDesktopStateForCwd(targetCwd, tempBaseDir);
    expect(result).toEqual({
      kind: "found",
      state: {
        display: 105,
        port: 48685,
        slug: "feature",
        browserEnabled: true,
        browserUrl: "https://spark.tailnet.ts.net:20105/",
        worktreePath: targetCwd,
      },
    });

    const summary = findDesktopStateSummary(targetCwd, tempBaseDir);
    expect(summary).toEqual({
      display: 105,
      port: 48685,
      slug: "feature",
    });
  });

  it("returns invalid_state when display number is out of bounds", () => {
    const targetCwd = "/home/user/worktrees/feature";
    const deskDir = join(tempBaseDir, "feature");
    mkdirSync(deskDir, { recursive: true });
    writeFileSync(
      join(deskDir, "state.json"),
      JSON.stringify({
        display: 50, // Must be between 103 and 999
        port: 48650,
        worktree_path: targetCwd,
      }),
    );

    const result = findDesktopStateForCwd(targetCwd, tempBaseDir);
    expect(result).toEqual({
      kind: "invalid_state",
      message: expect.stringMatching(/display/i),
    });
  });

  it("returns invalid_state when port is not a positive integer", () => {
    const targetCwd = "/home/user/worktrees/feature";
    const deskDir = join(tempBaseDir, "feature");
    mkdirSync(deskDir, { recursive: true });
    writeFileSync(
      join(deskDir, "state.json"),
      JSON.stringify({
        display: 110,
        port: -1,
        worktree_path: targetCwd,
      }),
    );

    const result = findDesktopStateForCwd(targetCwd, tempBaseDir);
    expect(result).toEqual({
      kind: "invalid_state",
      message: expect.stringMatching(/port/i),
    });
  });

  it("returns parse_error when matching directory state.json has invalid JSON", () => {
    const targetCwd = "/home/user/worktrees/feature";
    const deskDir = join(tempBaseDir, "feature");
    mkdirSync(deskDir, { recursive: true });
    writeFileSync(join(deskDir, "state.json"), "{ invalid json");

    const result = findDesktopStateForCwd(targetCwd, tempBaseDir);
    expect(result).toEqual({
      kind: "parse_error",
      message: expect.stringMatching(/syntax/i),
    });
  });
});
