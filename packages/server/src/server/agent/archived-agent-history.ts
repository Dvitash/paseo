import { createHash } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { AgentTimelineItemPayloadSchema } from "@getpaseo/protocol/messages";
import { writeJsonFileAtomic } from "../atomic-file.js";
import type { AgentTimelineRow } from "./agent-timeline-store-types.js";

const HistorySchema = z.object({
  archivedAt: z.string(),
  epoch: z.string(),
  nextSeq: z.number().int().nonnegative(),
  rows: z.array(
    z.object({
      seq: z.number().int().nonnegative(),
      timestamp: z.string(),
      item: AgentTimelineItemPayloadSchema,
      turnId: z.string().optional(),
      providerMessageId: z.string().optional(),
    }),
  ),
});

export interface ArchivedAgentHistory {
  archivedAt: string;
  epoch: string;
  nextSeq: number;
  rows: AgentTimelineRow[];
}

/** A transcript copy, not a native session or a substitute for provider persistence. */
export class ArchivedAgentHistoryStore {
  constructor(private readonly agentDirectory: string) {}

  private path(agentId: string): string {
    const key = createHash("sha256").update(agentId).digest("hex");
    // The agent registry discovers *.json records one directory deep.
    return join(this.agentDirectory, ".archived-history", `${key}.timeline`);
  }

  async read(agentId: string, archivedAt: string): Promise<ArchivedAgentHistory | null> {
    let text: string;
    try {
      text = await readFile(this.path(agentId), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    const saved = HistorySchema.parse(JSON.parse(text));
    // A previous archive must never replace a newer native conversation.
    return saved.archivedAt === archivedAt ? saved : null;
  }

  async write(agentId: string, history: ArchivedAgentHistory): Promise<void> {
    await writeJsonFileAtomic(this.path(agentId), HistorySchema.parse(history));
  }

  async remove(agentId: string): Promise<void> {
    await rm(this.path(agentId), { force: true });
  }
}
