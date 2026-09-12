import { beforeEach, describe, expect, it } from "vitest";
import {
  clearAssistantImageMetadataCache,
  estimateAssistantMessageHeightFromCache,
  extractAssistantImageSources,
  getAssistantImageMetadata,
  setAssistantImageMetadata,
} from "./assistant-image-metadata";

beforeEach(() => {
  clearAssistantImageMetadataCache();
});

describe("assistant image metadata", () => {
  it("extracts markdown image sources", () => {
    expect(
      extractAssistantImageSources(
        'Before\n\n![local](/tmp/paseo.png)\n\n![remote](https://example.com/test.png "Remote")',
      ),
    ).toEqual(["/tmp/paseo.png", "https://example.com/test.png"]);
  });

  it("reuses cached metadata across canonical and raw source keys", () => {
    setAssistantImageMetadata(
      {
        source: "/tmp/paseo-codex-screenshot.png",
        workspaceRoot: "/workspaces/paseo",
        serverId: "server-1",
      },
      { width: 1200, height: 800 },
    );

    expect(
      getAssistantImageMetadata({
        source: "/tmp/paseo-codex-screenshot.png",
      }),
    ).toEqual({
      width: 1200,
      height: 800,
      aspectRatio: 1.5,
    });
  });

  it("estimates assistant message height from cached image metadata", () => {
    setAssistantImageMetadata(
      {
        source: "https://example.com/landscape.png",
      },
      { width: 1200, height: 800 },
    );

    expect(
      estimateAssistantMessageHeightFromCache(
        "Here is the screenshot\n\n![Screenshot](https://example.com/landscape.png)",
      ),
    ).toBeGreaterThan(220);
  });

  it("estimates image-only data-image markdown without caching the full payload as text", () => {
    const source = `data:image/png;base64,${"a".repeat(512)}`;
    setAssistantImageMetadata({ source }, { width: 1200, height: 800 });

    const imageOnlyHeight = estimateAssistantMessageHeightFromCache(`![Screenshot](${source})`);
    const mixedHeight = estimateAssistantMessageHeightFromCache(`Text\n\n![Screenshot](${source})`);

    expect(imageOnlyHeight).toBeGreaterThan(220);
    expect(mixedHeight).toBeGreaterThan(imageOnlyHeight ?? 0);
  });
});

// Every metadata key embeds its full source, so a long signed URL is what makes
// the retained-byte budget — rather than the 500-entry cap — the binding limit.
function longSource(index: number): string {
  return `https://cdn.example.com/assets/${"p".repeat(6_000)}-${index}.png?sig=${index}`;
}

function longMarkdown(index: number): string {
  return `Message ${index}\n\n${"prose ".repeat(400)}\n\n![Screenshot](https://example.com/${index}.png)`;
}

describe("assistant image metadata byte budget", () => {
  it("evicts the oldest sources by retained bytes before the entry cap is reached", () => {
    const sources = Array.from({ length: 200 }, (_, index) => longSource(index));
    for (const [index, source] of sources.entries()) {
      setAssistantImageMetadata({ source }, { width: 100 + index, height: 200 });
    }

    // 200 sources occupy 400 keys, under the 500-entry cap, yet far past 1 MiB:
    // eviction can only have come from the byte budget.
    expect(getAssistantImageMetadata({ source: sources[0] })).toBeNull();
    expect(getAssistantImageMetadata({ source: sources[100] })).toBeNull();

    const newest = getAssistantImageMetadata({ source: sources[199] });
    expect(newest).toEqual({ width: 299, height: 200, aspectRatio: 299 / 200 });
    expect(getAssistantImageMetadata({ source: sources[199] })).toBe(newest);
  });

  it("keeps a hot source cached while new sources churn around it", () => {
    const hot = "https://example.com/hot.png";
    setAssistantImageMetadata({ source: hot }, { width: 640, height: 480 });
    const hotMetadata = getAssistantImageMetadata({ source: hot });

    for (let index = 0; index < 200; index += 1) {
      const source = longSource(index);
      setAssistantImageMetadata({ source }, { width: 100, height: 200 });
      expect(getAssistantImageMetadata({ source: hot })).toBe(hotMetadata);
    }
  });

  it("does not flush hot sources when a single source is over budget", () => {
    const hot = "https://example.com/hot.png";
    setAssistantImageMetadata({ source: hot }, { width: 640, height: 480 });
    const hotMetadata = getAssistantImageMetadata({ source: hot });

    // One key of this size exceeds the whole 1 MiB budget; it cannot be
    // retained, and it must not evict what is already cached.
    const oversized = `https://cdn.example.com/huge.png?sig=${"s".repeat(600_000)}`;
    const metadata = setAssistantImageMetadata({ source: oversized }, { width: 800, height: 400 });
    expect(metadata).toEqual({ width: 800, height: 400, aspectRatio: 2 });

    expect(getAssistantImageMetadata({ source: oversized })).toBeNull();
    expect(getAssistantImageMetadata({ source: hot })).toBe(hotMetadata);
  });

  it("never aliases distinct sources that share a prefix", () => {
    const shared = `https://cdn.example.com/${"q".repeat(4_000)}`;
    const first = `${shared}/first.png`;
    const second = `${shared}/second.png`;

    setAssistantImageMetadata({ source: first }, { width: 100, height: 100 });
    setAssistantImageMetadata({ source: second }, { width: 200, height: 50 });

    expect(getAssistantImageMetadata({ source: first })).toEqual({
      width: 100,
      height: 100,
      aspectRatio: 1,
    });
    expect(getAssistantImageMetadata({ source: second })).toEqual({
      width: 200,
      height: 50,
      aspectRatio: 4,
    });
  });

  it("releases the metadata budget on clear", () => {
    for (let index = 0; index < 200; index += 1) {
      const source = longSource(index);
      setAssistantImageMetadata({ source }, { width: 100, height: 200 });
    }

    clearAssistantImageMetadataCache();

    const retained = [0, 1, 2, 3].map((index) => longSource(index));
    for (const source of retained) {
      setAssistantImageMetadata({ source }, { width: 100, height: 200 });
    }
    for (const source of retained) {
      expect(getAssistantImageMetadata({ source })).not.toBeNull();
    }
  });
});

describe("assistant message parse cache byte budget", () => {
  it("evicts the oldest messages by retained bytes before the entry cap is reached", () => {
    const messages = Array.from({ length: 300 }, (_, index) => longMarkdown(index));
    const cachedSources = messages.map((message) => extractAssistantImageSources(message));

    // 300 whole-document keys sit under the 500-entry cap but past 1 MiB, so
    // the oldest messages must have been dropped by the byte budget.
    expect(extractAssistantImageSources(messages[0])).not.toBe(cachedSources[0]);
    expect(extractAssistantImageSources(messages[0])).toEqual([`https://example.com/0.png`]);

    expect(extractAssistantImageSources(messages[299])).toBe(cachedSources[299]);
  });

  it("keeps a hot message cached while new messages churn around it", () => {
    const hot = longMarkdown(-1);
    const hotSources = extractAssistantImageSources(hot);

    for (let index = 0; index < 300; index += 1) {
      extractAssistantImageSources(longMarkdown(index));
      expect(extractAssistantImageSources(hot)).toBe(hotSources);
    }
  });

  it("never aliases distinct messages that share a prefix", () => {
    const shared = `Text\n\n${"shared prose ".repeat(300)}\n\n`;
    const first = `${shared}![Screenshot](https://example.com/first.png)`;
    const second = `${shared}![Screenshot](https://example.com/second.png)`;

    expect(extractAssistantImageSources(first)).toEqual(["https://example.com/first.png"]);
    expect(extractAssistantImageSources(second)).toEqual(["https://example.com/second.png"]);
    expect(extractAssistantImageSources(first)).toEqual(["https://example.com/first.png"]);
    expect(extractAssistantImageSources(second)).toEqual(["https://example.com/second.png"]);
  });

  it("releases the parse budget on clear", () => {
    for (let index = 0; index < 300; index += 1) {
      extractAssistantImageSources(longMarkdown(index));
    }

    clearAssistantImageMetadataCache();

    const retained = [0, 1, 2, 3].map((index) => longMarkdown(index));
    const cached = retained.map((message) => extractAssistantImageSources(message));
    retained.forEach((message, index) => {
      expect(extractAssistantImageSources(message)).toBe(cached[index]);
    });
  });
});
