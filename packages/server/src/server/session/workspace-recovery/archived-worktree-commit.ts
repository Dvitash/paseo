import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";

import { runGitCommand } from "../../../utils/run-git-command.js";
import type { PersistedWorkspaceRecord } from "../../workspace-registry.js";

// A ref, rather than only a SHA in JSON, keeps an archived commit reachable
// after its branch is deleted and Git runs garbage collection. Hash the opaque
// workspace ID so it cannot introduce ref/path syntax.
export function archivedWorktreeRef(workspaceId: string): string {
  const key = createHash("sha256").update(workspaceId).digest("hex");
  return `refs/paseo/archived-workspaces/${key}`;
}

export async function preserveArchivedWorkspaceCommit(
  workspace: Pick<PersistedWorkspaceRecord, "workspaceId" | "kind" | "cwd" | "worktreeRoot">,
): Promise<void> {
  if (workspace.kind !== "worktree") return;
  const cwd = workspace.worktreeRoot ?? workspace.cwd;
  try {
    if (!(await stat(cwd)).isDirectory()) return;
  } catch (error) {
    // Already-missing worktrees can still be archived. Other filesystem errors
    // must not be treated as proof that there is nothing left to preserve.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const { stdout } = await runGitCommand(["rev-parse", "--verify", "HEAD^{commit}"], { cwd });
  await runGitCommand(["update-ref", archivedWorktreeRef(workspace.workspaceId), stdout.trim()], {
    cwd,
  });
}

async function resolveCommit(cwd: string, ref: string): Promise<string | null> {
  const result = await runGitCommand(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], {
    cwd,
    acceptExitCodes: [0, 1],
  });
  return result.exitCode === 0 ? result.stdout.trim() : null;
}

export async function restoreArchivedWorkspaceBranch(input: {
  cwd: string;
  workspaceId: string;
  branchName: string;
}): Promise<void> {
  const { cwd, branchName } = input;
  if (branchName.startsWith("-")) throw new Error("Invalid archived branch name");
  await runGitCommand(["check-ref-format", `refs/heads/${branchName}`], { cwd });
  const localRef = `refs/heads/${branchName}`;
  if (await resolveCommit(cwd, localRef)) return;

  const savedCommit = await resolveCommit(cwd, archivedWorktreeRef(input.workspaceId));
  if (savedCommit) {
    // Never reset an existing branch. A concurrent recreation is a conflict,
    // not permission to force-update it to the archived commit.
    await runGitCommand(["branch", "--no-track", branchName, savedCommit], { cwd });
    return;
  }

  // Legacy archives have no recovery ref. A locally retained remote-tracking
  // ref is still useful when the remote has deleted the branch or is offline.
  const remoteCommit = await resolveCommit(cwd, `refs/remotes/origin/${branchName}`);
  if (remoteCommit) {
    await runGitCommand(["branch", "--no-track", branchName, remoteCommit], { cwd });
    return;
  }

  const remotes = await runGitCommand(["remote"], { cwd });
  if (!remotes.stdout.split(/\r?\n/).includes("origin")) {
    throw new Error(
      `Cannot restore branch "${branchName}": no local branch, saved archive commit, or origin remote is available. Restore the branch manually or continue the saved conversation in another workspace.`,
    );
  }

  try {
    // Exit 2 means the remote answered successfully but has no matching head.
    // Authentication, transport and repository failures must retain Git's
    // diagnostics instead of being rewritten to "Unknown branch".
    const remote = await runGitCommand(
      ["ls-remote", "--exit-code", "--heads", "origin", localRef],
      { cwd, timeout: 30_000, acceptExitCodes: [0, 2] },
    );
    if (remote.exitCode === 2) {
      throw new Error(
        `Branch "${branchName}" is missing locally and on origin, and this archive has no saved commit. Restore the branch manually or continue the saved conversation in another workspace.`,
      );
    }
    await runGitCommand(["fetch", "--no-tags", "origin", `${localRef}:${localRef}`], {
      cwd,
      timeout: 90_000,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not restore "${branchName}" from origin: ${detail}`, { cause: error });
  }
}
