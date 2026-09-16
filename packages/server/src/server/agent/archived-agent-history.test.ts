import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { AgentStorage } from "./agent-storage.js";
import { AgentManager } from "./agent-manager.js";
import { createTestLogger } from "../../test-utils/test-logger.js";
import { createTestAgentClients } from "../test-utils/fake-agent-client.js";
import { OmpAgentClient } from "./providers/omp/agent.js";
import { FakeOmp } from "./providers/omp/test-utils/fake-omp.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "saved-history-"));
  roots.push(root);
  const logger = createTestLogger();
  const directory = join(root, "agents");
  const storage = new AgentStorage(directory, logger);
  return { root, logger, directory, storage };
}

test("snapshots survive missing cwd and daemon restart without an available provider", async () => {
  const { root, logger, directory, storage } = await fixture();
  const cwd = join(root, "worktree");
  await mkdir(cwd);
  const manager = new AgentManager({
    logger,
    registry: storage,
    clients: createTestAgentClients(),
  });
  const agent = await manager.createAgent({ provider: "codex", cwd }, undefined, {
    workspaceId: "saved-workspace",
  });
  await manager.appendTimelineItem(agent.id, {
    type: "user_message",
    text: "remember this",
    messageId: "prompt",
  });
  await manager.appendTimelineItem(agent.id, { type: "assistant_message", text: "saved answer" });
  await manager.archiveAgent(agent.id);
  const record = await storage.get(agent.id);
  await manager.flush();
  await storage.flush();
  await rm(cwd, { recursive: true });
  const reloaded = new AgentStorage(directory, logger);
  expect((await reloaded.list()).map((r) => r.id)).toEqual([agent.id]);
  const restarted = new AgentManager({ logger, registry: reloaded, clients: {} });
  const history = await restarted.loadSavedAgentTimeline(agent.id);
  const tail = history.fetch(agent.id, { limit: 1 });
  expect(tail.rows.at(-1)?.item).toEqual({ type: "assistant_message", text: "saved answer" });
  const older = history.fetch(agent.id, {
    direction: "before",
    cursor: { epoch: tail.epoch, seq: tail.rows[0]!.seq },
    limit: 1,
  });
  expect(older.rows[0]?.item).toMatchObject({ text: "remember this", messageId: "prompt" });
  expect(restarted.getAgent(agent.id)).toBeNull();
  expect(await reloaded.get(agent.id)).toEqual(record);
  expect(await reloaded.archivedHistory.read(agent.id, "different-archive")).toBeNull();
  await reloaded.remove(agent.id);
  expect(await reloaded.archivedHistory.read(agent.id, record!.archivedAt!)).toBeNull();
});

test("legacy OMP disk history keeps IDs and cursors without starting OMP or changing records", async () => {
  const { root, logger, storage } = await fixture();
  const sessionFile = join(root, "session.jsonl");
  await writeFile(
    sessionFile,
    [
      {
        type: "session",
        id: "session",
        timestamp: "2026-09-16T10:00:00Z",
        cwd: join(root, "deleted"),
      },
      {
        type: "message",
        id: "user",
        parentId: null,
        timestamp: "2026-09-16T10:01:00Z",
        message: { role: "user", content: "original prompt" },
      },
      {
        type: "message",
        id: "assistant",
        parentId: "user",
        timestamp: "2026-09-16T10:02:00Z",
        message: { role: "assistant", content: [{ type: "text", text: "original answer" }] },
      },
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n"),
  );
  const before = await readFile(sessionFile, "utf8");
  const runtime = new FakeOmp();
  const start = vi.spyOn(runtime, "startSession");
  const client = new OmpAgentClient({ logger, runtime });
  const time = "2026-09-16T11:00:00Z";
  const record = {
    id: "legacy",
    provider: "omp",
    cwd: join(root, "deleted"),
    createdAt: time,
    updatedAt: time,
    archivedAt: time,
    lastStatus: "closed" as const,
    labels: {},
    persistence: { provider: "omp", sessionId: "session", nativeHandle: sessionFile },
  };
  await storage.upsert(record);
  const manager = new AgentManager({ logger, registry: storage, clients: { omp: client } });
  const first = (await manager.loadSavedAgentTimeline("legacy")).fetch("legacy", { limit: 0 });
  const second = (await manager.loadSavedAgentTimeline("legacy")).fetch("legacy", { limit: 0 });
  expect(first.epoch).toBe(second.epoch);
  expect(first.rows.map((r) => r.item)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ type: "user_message", text: "original prompt", messageId: "user" }),
      expect.objectContaining({ type: "assistant_message", text: "original answer" }),
    ]),
  );
  expect(start).not.toHaveBeenCalled();
  expect(manager.getAgent("legacy")).toBeNull();
  expect(await storage.get("legacy")).toEqual(record);
  expect(await readFile(sessionFile, "utf8")).toBe(before);
  await rm(sessionFile);
  await expect(manager.loadSavedAgentTimeline("legacy")).rejects.toThrow();
});
