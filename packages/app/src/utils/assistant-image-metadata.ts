import { MAX_CONTENT_WIDTH } from "@/constants/layout";
import { resolveAssistantImageSource } from "@/utils/assistant-image-source";
import { createImageSourceCacheKey } from "@/attachments/utils";

export interface AssistantImageMetadata {
  width: number;
  height: number;
  aspectRatio: number;
}

interface AssistantImageMarkdownParse {
  sources: string[];
  hasNonImageText: boolean;
}

// Both caches live for the whole session and are keyed by whole markdown
// messages, so entry count alone does not bound them. Retained bytes are an
// estimated budget, not a heap measurement: keys are counted at their UTF16
// length and values at a conservative per-object overhead.
const ASSISTANT_IMAGE_METADATA_CACHE_LIMIT = 500;
const ASSISTANT_IMAGE_METADATA_CACHE_BYTE_BUDGET = 1024 * 1024;
const ASSISTANT_IMAGE_PARSE_CACHE_LIMIT = 500;
const ASSISTANT_IMAGE_PARSE_CACHE_BYTE_BUDGET = 1024 * 1024;
const ASSISTANT_IMAGE_METADATA_BYTES = 32;
const ASSISTANT_IMAGE_PARSE_BYTES = 48;
const ASSISTANT_IMAGE_PARSE_SOURCE_BYTES = 16;

interface RetainedEntry<V> {
  value: V;
  bytes: number;
}

// Map iteration order is insertion order, so a read refreshes recency by
// re-inserting. Byte totals are maintained incrementally: no accounting pass
// ever walks the retained entries.
class RetainedEntryCache<V> {
  private readonly entries = new Map<string, RetainedEntry<V>>();
  private retainedBytes = 0;

  constructor(
    private readonly maxEntries: number,
    private readonly maxBytes: number,
    private readonly estimateValueBytes: (value: V) => number,
  ) {}

  get(key: string): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: V): void {
    const bytes = key.length * 2 + this.estimateValueBytes(value);
    // A value larger than the whole budget can never be retained; dropping it
    // here keeps the existing entries instead of flushing the cache to make
    // room for something that would immediately be evicted again.
    if (bytes > this.maxBytes) return;

    const previous = this.entries.get(key);
    if (previous) {
      this.entries.delete(key);
      this.retainedBytes -= previous.bytes;
    }

    this.entries.set(key, { value, bytes });
    this.retainedBytes += bytes;

    while (this.entries.size > this.maxEntries || this.retainedBytes > this.maxBytes) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey === undefined) return;
      const oldest = this.entries.get(oldestKey);
      this.entries.delete(oldestKey);
      if (oldest) this.retainedBytes -= oldest.bytes;
    }
  }

  clear(): void {
    this.entries.clear();
    this.retainedBytes = 0;
  }
}

function estimateParseBytes(parsed: AssistantImageMarkdownParse): number {
  let bytes = ASSISTANT_IMAGE_PARSE_BYTES;
  for (const source of parsed.sources) {
    bytes += ASSISTANT_IMAGE_PARSE_SOURCE_BYTES + source.length * 2;
  }
  return bytes;
}

const assistantImageMetadataCache = new RetainedEntryCache<AssistantImageMetadata>(
  ASSISTANT_IMAGE_METADATA_CACHE_LIMIT,
  ASSISTANT_IMAGE_METADATA_CACHE_BYTE_BUDGET,
  () => ASSISTANT_IMAGE_METADATA_BYTES,
);

const assistantImageParseCache = new RetainedEntryCache<AssistantImageMarkdownParse>(
  ASSISTANT_IMAGE_PARSE_CACHE_LIMIT,
  ASSISTANT_IMAGE_PARSE_CACHE_BYTE_BUDGET,
  estimateParseBytes,
);

const MARKDOWN_IMAGE_PATTERN = /!\[[^\]]*]\((<[^>]+>|[^)\n]+)\)/g;
const ASSISTANT_IMAGE_ESTIMATE_WIDTH = MAX_CONTENT_WIDTH - 8;
const ASSISTANT_IMAGE_MIN_HEIGHT = 160;
const ASSISTANT_IMAGE_BLOCK_GAP = 24;
const ASSISTANT_MESSAGE_BASE_HEIGHT = 96;
const ASSISTANT_MESSAGE_MIN_HEIGHT = 220;
const ASSISTANT_MESSAGE_IMAGE_ONLY_BASE_HEIGHT = 40;

function normalizeAssistantImageSourceToken(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  if (trimmed.startsWith("<") && trimmed.endsWith(">")) {
    const inner = trimmed.slice(1, -1).trim();
    return inner || null;
  }

  const titleMatch = /^(.*?)(?:\s+(['"]).*?\2)?$/.exec(trimmed);
  const source = titleMatch?.[1]?.trim() ?? trimmed;
  return source || null;
}

function parseAssistantImageMarkdown(markdown: string): AssistantImageMarkdownParse {
  const sources: string[] = [];
  for (const match of markdown.matchAll(MARKDOWN_IMAGE_PATTERN)) {
    const normalized = normalizeAssistantImageSourceToken(match[1] ?? "");
    if (normalized) {
      sources.push(normalized);
    }
  }
  return {
    sources,
    hasNonImageText: markdown.replace(MARKDOWN_IMAGE_PATTERN, "").trim().length > 0,
  };
}

function createSourceAliasKey(source: string): string {
  return `source:${createImageSourceCacheKey(source)}`;
}

function createResolutionKey(input: {
  source: string;
  workspaceRoot?: string;
  serverId?: string;
}): string | null {
  const resolution = resolveAssistantImageSource({
    source: input.source,
    workspaceRoot: input.workspaceRoot,
  });
  if (!resolution) {
    return null;
  }
  if (resolution.kind === "direct") {
    return `direct:${createImageSourceCacheKey(resolution.uri)}`;
  }
  return `file:${input.serverId ?? "unknown-server"}:${resolution.cwd}:${resolution.path}`;
}

function getAssistantImageMetadataKeys(input: {
  source: string;
  workspaceRoot?: string;
  serverId?: string;
}): string[] {
  const source = input.source.trim();
  if (!source) {
    return [];
  }

  const keys = [createSourceAliasKey(source)];
  const resolutionKey = createResolutionKey(input);
  if (resolutionKey) {
    keys.unshift(resolutionKey);
  }
  return [...new Set(keys)];
}

export function getAssistantImageMetadata(input: {
  source: string;
  workspaceRoot?: string;
  serverId?: string;
}): AssistantImageMetadata | null {
  for (const key of getAssistantImageMetadataKeys(input)) {
    const metadata = assistantImageMetadataCache.get(key);
    if (metadata) {
      return metadata;
    }
  }
  return null;
}

export function setAssistantImageMetadata(
  input: {
    source: string;
    workspaceRoot?: string;
    serverId?: string;
  },
  dimensions: { width: number; height: number },
): AssistantImageMetadata | null {
  const { width, height } = dimensions;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return null;
  }

  const metadata: AssistantImageMetadata = {
    width,
    height,
    aspectRatio: width / height,
  };

  for (const key of getAssistantImageMetadataKeys(input)) {
    assistantImageMetadataCache.set(key, metadata);
  }

  return metadata;
}

export function extractAssistantImageSources(markdown: string): string[] {
  const shouldCacheParse = !/data:image\//i.test(markdown);
  const cachedParse = shouldCacheParse ? assistantImageParseCache.get(markdown) : undefined;
  if (cachedParse) {
    return cachedParse.sources;
  }

  const parsed = parseAssistantImageMarkdown(markdown);
  if (shouldCacheParse) {
    assistantImageParseCache.set(markdown, parsed);
  }
  return parsed.sources;
}

export function estimateAssistantMessageHeightFromCache(markdown: string): number | null {
  const parsed = assistantImageParseCache.get(markdown) ?? parseAssistantImageMarkdown(markdown);
  if (parsed.sources.length === 0) {
    return null;
  }

  const knownHeights = parsed.sources
    .map((source) => getAssistantImageMetadata({ source }))
    .filter((metadata): metadata is AssistantImageMetadata => metadata !== null)
    .map((metadata) =>
      Math.max(
        ASSISTANT_IMAGE_MIN_HEIGHT,
        Math.round(ASSISTANT_IMAGE_ESTIMATE_WIDTH / metadata.aspectRatio),
      ),
    );

  if (knownHeights.length === 0) {
    return null;
  }

  const baseHeight = parsed.hasNonImageText
    ? ASSISTANT_MESSAGE_BASE_HEIGHT
    : ASSISTANT_MESSAGE_IMAGE_ONLY_BASE_HEIGHT;

  const estimatedHeight =
    baseHeight +
    knownHeights.reduce((sum, height) => sum + height, 0) +
    ASSISTANT_IMAGE_BLOCK_GAP * knownHeights.length;

  return Math.max(ASSISTANT_MESSAGE_MIN_HEIGHT, estimatedHeight);
}

export function clearAssistantImageMetadataCache(): void {
  assistantImageMetadataCache.clear();
  assistantImageParseCache.clear();
}
