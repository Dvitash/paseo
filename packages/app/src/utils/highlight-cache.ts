import { highlightCode, type HighlightToken } from "@getpaseo/highlight";

// Shared, theme-independent tokenization + cache for syntax highlighting.
// Used by markdown code blocks, file preview, and tool-call detail blocks
// (Edit diff / Write / Read). Colors are applied at render time, so the cache
// key is just (extension, code) and one entry serves both light and dark.

export interface KeyedToken {
  key: string;
  token: HighlightToken;
}

export interface KeyedLine {
  key: string;
  tokens: KeyedToken[];
}

// Above this, highlighting a whole document on the main thread risks a visible
// stall when a large Read/Write block is expanded. Callers fall back to plain
// monospace text. Generous enough to cover the vast majority of real blocks.
export const MAX_HIGHLIGHT_CHARS = 100_000;

// Tokenization is retained for the whole session, so the cache is bounded by
// estimated bytes rather than entry count alone: a handful of large documents
// would otherwise pin megabytes of token text and token objects. A single
// document larger than the budget is not cached at all.
const HIGHLIGHT_CACHE_BYTE_BUDGET = 4 * 1024 * 1024;
const HIGHLIGHT_CACHE_MAX_ENTRIES = 200;

// Per-object overhead for the cached tokens and the per-line arrays holding
// them. Real V8 objects are smaller; overestimating keeps the budget a ceiling
// instead of an average, at no runtime cost.
const TOKEN_OBJECT_BYTES = 64;
const LINE_ARRAY_BYTES = 48;

interface RetainedEntry<V> {
  value: V;
  bytes: number;
}

// Map iteration order is insertion order, so a read refreshes recency by
// re-inserting. An entry's bytes are computed once, at insert time, and the
// retained total is maintained incrementally so no accounting pass walks live
// entries.
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

function estimateLinesBytes(lines: HighlightToken[][]): number {
  let bytes = 0;
  for (const tokens of lines) {
    bytes += LINE_ARRAY_BYTES;
    for (const token of tokens) {
      bytes += TOKEN_OBJECT_BYTES + token.text.length * 2;
    }
  }
  return bytes;
}

const tokenizationCache = new RetainedEntryCache<HighlightToken[][]>(
  HIGHLIGHT_CACHE_MAX_ENTRIES,
  HIGHLIGHT_CACHE_BYTE_BUDGET,
  estimateLinesBytes,
);

// Drops every cached tokenization together with the byte accounting that
// follows it, so a released cache never keeps the budget spent.
export function clearHighlightCache(): void {
  tokenizationCache.clear();
}

// Tokenize `code` to per-line tokens, cached. Returns null when the language is
// unsupported, the input is over the size cap, or parsing throws — callers then
// render plain text.
export function tokenizeFileToLines(
  code: string,
  filename: string | null,
): HighlightToken[][] | null {
  if (!filename) return null;
  if (code.length > MAX_HIGHLIGHT_CHARS) return null;
  const cacheKey = `${filename}:${code}`;
  const cached = tokenizationCache.get(cacheKey);
  if (cached) return cached;
  let lines: HighlightToken[][];
  try {
    lines = highlightCode(code, filename);
  } catch {
    return null;
  }
  tokenizationCache.set(cacheKey, lines);
  return lines;
}

export function tokenizeToLines(code: string, ext: string | null): HighlightToken[][] | null {
  return tokenizeFileToLines(code, ext ? `x.${ext}` : null);
}

function toKeyedLine(tokens: HighlightToken[], lineIndex: number): KeyedLine {
  return {
    key: `line-${lineIndex}`,
    tokens: tokens.map((token, tokenIndex) => ({
      key: `${lineIndex}-${tokenIndex}`,
      token,
    })),
  };
}

export function highlightFileToKeyedLines(
  code: string,
  filename: string | null,
): KeyedLine[] | null {
  const lines = tokenizeFileToLines(code, filename);
  return lines ? lines.map(toKeyedLine) : null;
}

export function highlightToKeyedLines(code: string, ext: string | null): KeyedLine[] | null {
  const lines = tokenizeToLines(code, ext);
  return lines ? lines.map(toKeyedLine) : null;
}

// Extension for grammar selection from a file path. We only need the suffix —
// absolute vs relative paths are equivalent here.
export function extensionFromPath(filePath: string | null | undefined): string | null {
  if (!filePath) return null;
  const name = filePath.split(/[\\/]/).pop() ?? filePath;
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return null;
  return name.slice(dot + 1).toLowerCase();
}
