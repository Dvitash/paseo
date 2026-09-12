import { describe, expect, it } from "vitest";
import type { HighlightToken } from "@getpaseo/highlight";
import {
  clearHighlightCache,
  extensionFromPath,
  highlightToKeyedLines,
  MAX_HIGHLIGHT_CHARS,
  tokenizeToLines,
} from "./highlight-cache";

describe("extensionFromPath", () => {
  it("extracts a lowercased extension regardless of absolute/relative path", () => {
    expect(extensionFromPath("/repo/src/Index.TS")).toBe("ts");
    expect(extensionFromPath("src/index.ts")).toBe("ts");
    expect(extensionFromPath("a.b/c.tsx")).toBe("tsx");
  });

  it("returns null for paths without a usable extension", () => {
    expect(extensionFromPath(null)).toBeNull();
    expect(extensionFromPath(undefined)).toBeNull();
    expect(extensionFromPath("Makefile")).toBeNull();
    expect(extensionFromPath(".gitignore")).toBeNull();
    expect(extensionFromPath("trailingdot.")).toBeNull();
  });
});

describe("tokenizeToLines", () => {
  it("returns one token array per line for a supported language", () => {
    const lines = tokenizeToLines("const a = 1;\nconst b = 2;", "ts");
    expect(lines).not.toBeNull();
    expect(lines).toHaveLength(2);
    expect(lines?.[0].some((token) => token.style === "keyword")).toBe(true);
  });

  it("returns null when there is no extension", () => {
    expect(tokenizeToLines("whatever", null)).toBeNull();
  });

  it("falls back to style-less per-line tokens for an unknown extension", () => {
    const lines = tokenizeToLines("line one\nline two", "unknownext");
    expect(lines).toHaveLength(2);
    expect(lines?.[0]).toEqual([{ text: "line one", style: null }]);
  });

  it("returns null above the size cap so callers fall back to plain text", () => {
    const huge = "x".repeat(MAX_HIGHLIGHT_CHARS + 1);
    expect(tokenizeToLines(huge, "ts")).toBeNull();
  });

  it("serves a cached result on repeat calls (identity-stable)", () => {
    const first = tokenizeToLines("const cached = true;", "ts");
    const second = tokenizeToLines("const cached = true;", "ts");
    expect(first).toBe(second);
  });
});

// A single long line keeps each entry's cost dominated by its key and token
// text, so a few documents reach the 4 MiB budget without nearing
// MAX_HIGHLIGHT_CHARS.
function largeSource(marker: string, chars: number): string {
  return `const ${marker} = "${"x".repeat(chars)}";`;
}

// Unknown extensions take the per-line fallback (one token per line), so an
// entry's estimated bytes grow with line count independently of any grammar:
// 50k one-character lines estimate well past 4 MiB while the document itself
// stays under MAX_HIGHLIGHT_CHARS.
function overBudgetLines(lineCount: number): string {
  return Array.from({ length: lineCount }, (_, index) => String(index % 10)).join("\n");
}

function textOf(lines: HighlightToken[][] | null): string {
  return (lines ?? []).map((tokens) => tokens.map((token) => token.text).join("")).join("\n");
}

describe("tokenizeToLines byte budget", () => {
  it("evicts older documents by retained bytes well before the entry cap", () => {
    clearHighlightCache();
    const documents = Array.from({ length: 40 }, (_, index) => largeSource(`bulk${index}`, 60_000));
    const firstPass = documents.map((document) => tokenizeToLines(document, "ts"));
    const newest = documents.length - 1;

    // 40 documents of this size are past 4 MiB but nowhere near the 200-entry
    // cap, so eviction can only have come from the byte budget.
    expect(tokenizeToLines(documents[0], "ts")).not.toBe(firstPass[0]);
    expect(tokenizeToLines(documents[newest], "ts")).toBe(firstPass[newest]);

    // A small document inserted after the burst is still served by identity.
    const small = "const newest = 1;";
    const cachedSmall = tokenizeToLines(small, "ts");
    expect(cachedSmall).not.toBeNull();
    expect(tokenizeToLines(small, "ts")).toBe(cachedSmall);
  });

  it("keeps a hot document cached while new documents churn around it", () => {
    clearHighlightCache();
    const hot = largeSource("hot", 60_000);
    const hotLines = tokenizeToLines(hot, "ts");

    for (let index = 0; index < 30; index += 1) {
      tokenizeToLines(largeSource(`churn${index}`, 60_000), "ts");
      expect(tokenizeToLines(hot, "ts")).toBe(hotLines);
    }
  });

  it("returns correct highlighting for an over-budget document without flushing the hot cache", () => {
    clearHighlightCache();
    const hot = "const hot = 1;";
    const hotLines = tokenizeToLines(hot, "ts");

    // One-token-per-line source of this length stays under MAX_HIGHLIGHT_CHARS
    // but estimates ~6 MiB of tokens, so it cannot be retained — while the
    // result must still be complete.
    const oversized = overBudgetLines(50_000);
    expect(oversized.length).toBeLessThan(MAX_HIGHLIGHT_CHARS);
    const oversizedLines = tokenizeToLines(oversized, "unknownext");
    expect(oversizedLines).toHaveLength(50_000);
    expect(oversizedLines?.[0]).toEqual([{ text: "0", style: null }]);
    expect(oversizedLines?.[49_999]).toEqual([{ text: "9", style: null }]);

    expect(tokenizeToLines(oversized, "unknownext")).not.toBe(oversizedLines);
    expect(tokenizeToLines(hot, "ts")).toBe(hotLines);
  });

  it("never aliases distinct documents that share a prefix", () => {
    clearHighlightCache();
    const shared = "const value = 1;".repeat(1_000);
    const first = `${shared}\nconst tail = 1;`;
    const second = `${shared}\nconst tail = 2;`;

    const firstLines = tokenizeToLines(first, "ts");
    const secondLines = tokenizeToLines(second, "ts");
    expect(firstLines).not.toBe(secondLines);
    expect(tokenizeToLines(first, "ts")).toBe(firstLines);
    expect(tokenizeToLines(second, "ts")).toBe(secondLines);

    expect(textOf(firstLines)).toBe(first);
    expect(textOf(secondLines)).toBe(second);
  });

  it("releases the retained-byte budget on clear", () => {
    clearHighlightCache();
    for (let index = 0; index < 40; index += 1) {
      tokenizeToLines(largeSource(`before${index}`, 60_000), "ts");
    }

    clearHighlightCache();

    // Three documents fit the budget only if clear reset the accounting; a
    // stale total would evict them immediately.
    const documents = [0, 1, 2].map((index) => largeSource(`after${index}`, 60_000));
    const lines = documents.map((document) => tokenizeToLines(document, "ts"));
    documents.forEach((document, index) => {
      expect(tokenizeToLines(document, "ts")).toBe(lines[index]);
    });
  });
});

describe("highlightToKeyedLines", () => {
  it("produces stable keys for lines and tokens", () => {
    const keyed = highlightToKeyedLines("const a = 1;", "ts");
    expect(keyed?.[0].key).toBe("line-0");
    expect(keyed?.[0].tokens[0].key).toBe("0-0");
  });

  it("returns null when highlighting is unavailable", () => {
    expect(highlightToKeyedLines("text", null)).toBeNull();
  });
});
