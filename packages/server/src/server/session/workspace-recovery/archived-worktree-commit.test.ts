import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { createTestLogger } from "../../../../test-utils/test-logger.js";
import {
  archivedWorktreeRef,
  preserveArchivedWorkspaceCommit,
  restoreArchivedWorkspaceBranch,
} from "./archived-worktree-commit.js";
import { createWorkspaceRecoveryService } from "./workspace-recovery-service.js";
import { createWorktree } from "../../../utils/worktree.js";
import { archivePersistedWorkspaceRecord } from "../../workspace-archive-service.js";
import {
  createPersistedWorkspaceRecord,
  createPersistedProjectRecord,
  FileBackedWorkspaceRegistry,
} from "../../workspace-registry.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "archive-commit-"));
  roots.push(root);
  const repo = join(root, "repo");
  mkdirSync(repo);
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: "pipe" }).trim();
  git("init", "-b", "main");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.com");
  writeFileSync(join(repo, "README.md"), "main");
  git("add", ".");
  git("commit", "-m", "main");
  const main = git("rev-parse", "HEAD");
  return { root, repo, git, main };
}

test("archive pins an exact worktree commit and restores the original branch/path after deletion and GC", async () => {
  const { root, repo, git, main } = fixture();
  const paseoHome = join(root, "paseo");
  const worktreesRoot = join(root, "worktrees");
  const created = await createWorktree({
    cwd: repo,
    worktreeSlug: "performance",
    source: { kind: "branch-off", baseBranch: "main", branchName: "performance" },
    runSetup: false,
    paseoHome,
    worktreesRoot,
  });
  writeFileSync(join(created.worktreePath, "saved.txt"), "saved work");
  git("-C", created.worktreePath, "add", ".");
  git("-C", created.worktreePath, "commit", "-m", "saved work");
  const head = git("rev-parse", "performance");
  const time = "2026-09-16T12:00:00Z";
  const registry = new FileBackedWorkspaceRegistry(
    join(root, "workspaces.json"),
    createTestLogger(),
  );
  const workspace = createPersistedWorkspaceRecord({
    workspaceId: "saved-workspace",
    projectId: "project",
    cwd: created.worktreePath,
    worktreeRoot: created.worktreePath,
    mainRepoRoot: repo,
    isPaseoOwnedWorktree: true,
    branch: "performance",
    kind: "worktree",
    displayName: "performance",
    createdAt: time,
    updatedAt: time,
  });
  await registry.upsert(workspace);
  await archivePersistedWorkspaceRecord({
    workspaceRegistry: registry,
    workspaceId: workspace.workspaceId,
  });
  expect(git("rev-parse", archivedWorktreeRef(workspace.workspaceId))).toBe(head);
  git("worktree", "remove", created.worktreePath);
  git("branch", "-D", "performance");
  git("reflog", "expire", "--expire=now", "--all");
  git("gc", "--prune=now");
  const unarchived: string[] = [];
  const project = createPersistedProjectRecord({
    projectId: "project",
    kind: "git",
    rootPath: repo,
    displayName: "repo",
    createdAt: time,
    updatedAt: time,
  });
  const service = createWorkspaceRecoveryService({
    paseoHome,
    worktreesRoot,
    getWorkspace: (id) => registry.get(id),
    getProject: async () => project,
    isDirectory: async (path) => existsSync(path),
    unarchiveWorkspace: async (record) => {
      unarchived.push(record.workspaceId);
    },
  });
  await service.restore(workspace.workspaceId);
  expect(git("rev-parse", "performance")).toBe(head);
  expect(git("rev-parse", "main")).toBe(main);
  expect(existsSync(join(created.worktreePath, "saved.txt"))).toBe(true);
  expect(unarchived).toEqual([workspace.workspaceId]);
});

test("retains existing branches and recovers legacy origin tracking refs without network", async () => {
  const { repo, git, main } = fixture();
  git("branch", "performance");
  await preserveArchivedWorkspaceCommit({
    workspaceId: "w",
    kind: "worktree",
    cwd: repo,
    worktreeRoot: repo,
  });
  writeFileSync(join(repo, "new.txt"), "new");
  git("add", ".");
  git("commit", "-m", "new");
  git("branch", "-f", "performance", "HEAD");
  const newer = git("rev-parse", "performance");
  await restoreArchivedWorkspaceBranch({ cwd: repo, workspaceId: "w", branchName: "performance" });
  expect(git("rev-parse", "performance")).toBe(newer);
  git("update-ref", "refs/remotes/origin/legacy", main);
  await restoreArchivedWorkspaceBranch({ cwd: repo, workspaceId: "old", branchName: "legacy" });
  expect(git("rev-parse", "legacy")).toBe(main);
});

test("distinguishes a missing branch from transport failure and rejects Git shorthand", async () => {
  const { root, repo, git } = fixture();
  const remote = join(root, "remote.git");
  git("init", "--bare", remote);
  git("remote", "add", "origin", remote);
  await expect(
    restoreArchivedWorkspaceBranch({ cwd: repo, workspaceId: "w", branchName: "missing" }),
  ).rejects.toThrow("missing locally and on origin");
  git("remote", "set-url", "origin", join(root, "nonexistent.git"));
  await expect(
    restoreArchivedWorkspaceBranch({ cwd: repo, workspaceId: "w", branchName: "missing" }),
  ).rejects.toThrow(/does not appear to be a git repository|Could not read from remote repository/);
  await expect(
    restoreArchivedWorkspaceBranch({ cwd: repo, workspaceId: "w", branchName: "@{-1}" }),
  ).rejects.toThrow();
  expect(() => git("rev-parse", "--verify", "refs/heads/missing")).toThrow();
});
