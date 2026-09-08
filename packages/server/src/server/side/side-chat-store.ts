import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { Logger } from "pino";
import { writeJsonFileAtomic } from "../atomic-file.js";
import { StoredSideChatRecordSchema, type StoredSideChatRecord } from "./types.js";

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export class SideChatStore {
  private readonly cache = new Map<string, StoredSideChatRecord>();
  private readonly storeDir: string;
  private loading: Promise<void> | null = null;

  constructor(storageDir: string, _logger?: Logger) {
    this.storeDir = path.join(storageDir, "side-chats");
  }

  loadAll(): Promise<void> {
    this.loading ??= this.load();
    return this.loading;
  }

  private async load(): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(this.storeDir, { withFileTypes: true });
    } catch (error) {
      if (isMissingFile(error)) return;
      this.loading = null;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const content = await fs.readFile(path.join(this.storeDir, entry.name), "utf8");
      const record = StoredSideChatRecordSchema.parse(JSON.parse(content));
      this.cache.set(record.mainAgentId, record);
    }
  }

  get(mainAgentId: string): StoredSideChatRecord | null {
    const record = this.cache.get(mainAgentId);
    return record ? structuredClone(record) : null;
  }

  private filePath(mainAgentId: string): string {
    const filename = createHash("sha256").update(mainAgentId).digest("hex");
    return path.join(this.storeDir, `${filename}.json`);
  }

  async save(record: StoredSideChatRecord): Promise<void> {
    const validated = StoredSideChatRecordSchema.parse(record);
    await writeJsonFileAtomic(this.filePath(record.mainAgentId), validated);
    this.cache.set(record.mainAgentId, validated);
  }

  async delete(mainAgentId: string): Promise<boolean> {
    const existed = this.cache.has(mainAgentId);
    try {
      await fs.unlink(this.filePath(mainAgentId));
    } catch (error) {
      if (!isMissingFile(error)) throw error;
    }
    this.cache.delete(mainAgentId);
    return existed;
  }

  list(): StoredSideChatRecord[] {
    return Array.from(this.cache.values(), (record) => structuredClone(record));
  }
}
