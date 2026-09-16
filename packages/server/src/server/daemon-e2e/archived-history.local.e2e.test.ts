import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { createDaemonTestContext } from "../test-utils/index.js";

test("saved timeline and fork context RPCs work with a deleted cwd without resuming or unarchiving", async () => {
  const root = await mkdtemp(join(tmpdir(), "archived-history-rpc-"));
  const cwd = join(root, "checkout");
  await mkdir(cwd);
  const ctx = await createDaemonTestContext();
  try {
    const agent = await ctx.client.createAgent({ provider: "codex", cwd, title: "Archived chat" });
    await ctx.client.sendMessage(agent.id, "Say 'saved context' and nothing else");
    await ctx.client.waitForFinish(agent.id, 5_000);
    const original = await ctx.client.fetchAgentTimeline(agent.id, {
      limit: 0,
      projection: "canonical",
    });
    expect(original.entries.some((entry) => entry.item.type === "user_message")).toBe(true);
    expect(original.entries.some((entry) => entry.item.type === "assistant_message")).toBe(true);
    await ctx.daemon.daemon.agentManager.archiveAgent(agent.id);
    await rm(cwd, { recursive: true });
    const manager = ctx.daemon.daemon.agentManager;
    const resume = vi.spyOn(manager, "resumeAgentFromPersistence");
    const unarchive = vi.spyOn(manager, "unarchiveSnapshot");
    const timeline = await ctx.client.fetchAgentTimeline(agent.id, {
      limit: 0,
      projection: "canonical",
      savedOnly: true,
    });
    expect(timeline.agent?.archivedAt).toBeTruthy();
    expect(timeline.entries.map((entry) => entry.item)).toEqual(
      original.entries.map((entry) => entry.item),
    );
    const context = await ctx.client.buildAgentForkContext(agent.id, { savedOnly: true });
    expect(context.attachment).toBeTruthy();
    expect(context.itemCount).toBeGreaterThan(0);
    expect(manager.getAgent(agent.id)).toBeNull();
    expect(resume).not.toHaveBeenCalled();
    expect(unarchive).not.toHaveBeenCalled();
  } finally {
    await ctx.cleanup();
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
