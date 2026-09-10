import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { z } from "zod";
import { validateDesktopUrl, type UrlValidationResult } from "../shared/rpc";
import type { DesktopState, DesktopStateReadResult } from "./types";

export { validateDesktopUrl, type UrlValidationResult };

export const DEFAULT_BASE_DIR =
  process.env.SPARK_WORKTREE_BASE_DIR || join(homedir(), ".local/share/spark-worktree-desktops");

const DesktopStateFileSchema = z.object({
  display: z.number().int().min(103).max(999),
  port: z.number().int().positive(),
  slug: z.string().optional(),
  browser_enabled: z.boolean().optional(),
  browser_url: z.string().optional(),
  worktree_path: z.string(),
});

const DesktopStateIdentitySchema = DesktopStateFileSchema.pick({ worktree_path: true });

export function findDesktopStateForCwd(
  cwd: string,
  baseDir: string = DEFAULT_BASE_DIR,
): DesktopStateReadResult {
  if (!existsSync(baseDir)) {
    return { kind: "not_found" };
  }

  const resolvedCwd = resolve(cwd);
  const targetBaseName = basename(resolvedCwd);

  let entries;
  try {
    entries = readdirSync(baseDir, { withFileTypes: true });
  } catch {
    return { kind: "not_found" };
  }

  for (const ent of entries) {
    if (!ent.isDirectory()) {
      continue;
    }
    const stateFile = join(baseDir, ent.name, "state.json");
    if (!existsSync(stateFile)) {
      continue;
    }

    let rawContent: string;
    try {
      rawContent = readFileSync(stateFile, "utf8");
    } catch {
      continue;
    }

    let rawJson: unknown;
    try {
      rawJson = JSON.parse(rawContent);
    } catch {
      if (ent.name === targetBaseName || rawContent.includes(resolvedCwd)) {
        return {
          kind: "parse_error",
          message: `Failed to parse state file in ${ent.name}: invalid JSON syntax`,
        };
      }
      continue;
    }

    const identity = DesktopStateIdentitySchema.safeParse(rawJson);
    if (!identity.success || resolve(identity.data.worktree_path) !== resolvedCwd) continue;

    const parseResult = DesktopStateFileSchema.safeParse(rawJson);
    if (!parseResult.success) {
      const issue = parseResult.error.issues[0];
      const field = issue ? issue.path.join(".") : "state";
      const issueMsg = issue ? issue.message : "validation failed";
      return {
        kind: "invalid_state",
        message: `Desktop state validation failed for ${field}: ${issueMsg}`,
      };
    }

    const data = parseResult.data;
    const slug = data.slug && data.slug.length > 0 ? data.slug : ent.name;
    const browserEnabled = data.browser_enabled === true;
    const browserUrl = data.browser_url && data.browser_url.length > 0 ? data.browser_url : null;

    const state: DesktopState = {
      display: data.display,
      port: data.port,
      slug,
      browserEnabled,
      browserUrl,
      worktreePath: data.worktree_path,
    };

    return {
      kind: "found",
      state,
    };
  }

  return { kind: "not_found" };
}

export function findDesktopStateSummary(
  cwd: string,
  baseDir: string = DEFAULT_BASE_DIR,
): { display: number; port: number; slug: string } | null {
  const result = findDesktopStateForCwd(cwd, baseDir);
  if (result.kind === "found") {
    return {
      display: result.state.display,
      port: result.state.port,
      slug: result.state.slug,
    };
  }
  return null;
}
