import { describe, expect, it } from "vitest";
import type { AttachmentMetadata, ComposerAttachment } from "@/attachments/types";
import {
  buildInlineImageToken,
  createInlineImageTextStore,
  expandInlineImageDeletion,
  findInlineImageTokens,
  isImageAttachmentAnchored,
  resolveInlineImageReferences,
  resolveInlineImageToken,
  stripInlineImageTokens,
  snapInlineImageCaret,
} from "./inline-images";

function imageAttachment(
  id: string,
  fileName = "shot.png",
): Extract<ComposerAttachment, { kind: "image" }> {
  const metadata: AttachmentMetadata = {
    id,
    mimeType: "image/png",
    storageType: "web-indexeddb",
    storageKey: `key-${id}`,
    fileName,
    createdAt: 0,
  };
  return { kind: "image", metadata };
}

describe("inline image tokens", () => {
  it("builds a token whose code derives from the attachment id", () => {
    const token = buildInlineImageToken("att_msg_1234_k7f3a9z2");
    expect(token).toBe("[image:k7f3a9z2]");
    expect(findInlineImageTokens(`a ${token} b`)).toEqual([
      { start: 2, end: 2 + token.length, code: "k7f3a9z2", label: null },
    ]);
  });

  it("finds multiple tokens and ignores lookalikes", () => {
    const text = `x [image:abc123] y [image:] z [image:${"a".repeat(65)}]`;
    const tokens = findInlineImageTokens(text);
    expect(tokens).toHaveLength(1);
    expect(tokens[0].code).toBe("abc123");
  });

  it("resolves a token to its attachment by code", () => {
    const a = imageAttachment("att_aaa11111");
    const b = imageAttachment("att_bbb22222");
    const token = findInlineImageTokens(buildInlineImageToken("att_bbb22222"))[0];
    expect(resolveInlineImageToken(token, [a, b])).toBe(b);
  });

  it("resolves pure-digit tokens positionally among image attachments", () => {
    const a = imageAttachment("att_aaa11111");
    const b = imageAttachment("att_bbb22222");
    const token = findInlineImageTokens("[image:2]")[0];
    expect(resolveInlineImageToken(token, [a, b])).toBe(b);
    expect(resolveInlineImageToken(findInlineImageTokens("[image:3]")[0], [a, b])).toBeNull();
  });

  it("prefers code resolution over positional for digit-looking codes", () => {
    const a = imageAttachment("12");
    const b = imageAttachment("att_bbb22222");
    const token = findInlineImageTokens("[image:12]")[0];
    expect(resolveInlineImageToken(token, [a, b])).toBe(a);
  });
});

describe("resolveInlineImageReferences", () => {
  it("rewrites tokens to wire image indices", () => {
    const a = imageAttachment("att_aaa11111");
    const b = imageAttachment("att_bbb22222");
    const text = `look ${buildInlineImageToken("att_aaa11111")} and ${buildInlineImageToken("att_bbb22222")} done`;
    const wireImages = [a.metadata, b.metadata];
    expect(resolveInlineImageReferences(text, wireImages, [a, b])).toBe(
      "look [image:1] and [image:2] done",
    );
  });

  it("leaves unresolved tokens untouched", () => {
    const a = imageAttachment("att_aaa11111");
    const text = `keep ${buildInlineImageToken("att_zzz99999")} but ${buildInlineImageToken("att_aaa11111")}`;
    expect(resolveInlineImageReferences(text, [a.metadata], [a])).toBe(
      "keep [image:zzz99999] but [image:1]",
    );
  });

  it("returns text unchanged when there are no tokens", () => {
    const a = imageAttachment("att_aaa11111");
    expect(resolveInlineImageReferences("plain text", [a.metadata], [a])).toBe("plain text");
  });
});

describe("stripInlineImageTokens", () => {
  it("removes tokens for the attachment and shifts the caret", () => {
    const a = imageAttachment("att_aaa11111");
    const b = imageAttachment("att_bbb22222");
    const tokenA = buildInlineImageToken("att_aaa11111");
    const tokenB = buildInlineImageToken("att_bbb22222");
    const text = `hi ${tokenA} mid ${tokenB} end`;
    const caret = text.length;
    const result = stripInlineImageTokens({
      text,
      attachment: a,
      attachments: [a, b],
      caret,
    });
    expect(result.text).toBe(`hi  mid ${tokenB} end`);
    expect(result.caret).toBe(caret - tokenA.length);
  });

  it("clamps a caret inside the removed token to its start", () => {
    const a = imageAttachment("att_aaa11111");
    const token = buildInlineImageToken("att_aaa11111");
    const text = `x${token}y`;
    const result = stripInlineImageTokens({
      text,
      attachment: a,
      attachments: [a],
      caret: 5,
    });
    expect(result.text).toBe("xy");
    expect(result.caret).toBe(1);
  });
});

describe("expandInlineImageDeletion", () => {
  const token = "[image:abc12345]";
  const text = `before ${token} after`;
  const tokenStart = text.indexOf(token);
  const tokenEnd = tokenStart + token.length;

  it("swallows the whole token on backspace at its end", () => {
    expect(
      expandInlineImageDeletion({
        text,
        start: tokenEnd,
        end: tokenEnd,
        direction: "backward",
      }),
    ).toEqual({ start: tokenStart, end: tokenEnd });
  });

  it("swallows the whole token on delete at its start", () => {
    expect(
      expandInlineImageDeletion({
        text,
        start: tokenStart,
        end: tokenStart,
        direction: "forward",
      }),
    ).toEqual({ start: tokenStart, end: tokenEnd });
  });

  it("returns null for a collapsed caret not touching a token", () => {
    expect(expandInlineImageDeletion({ text, start: 2, end: 2, direction: "backward" })).toBeNull();
  });

  it("expands a selection that partially overlaps a token", () => {
    expect(
      expandInlineImageDeletion({
        text,
        start: tokenStart + 3,
        end: tokenEnd + 4,
        direction: "backward",
      }),
    ).toEqual({ start: tokenStart, end: tokenEnd + 4 });
  });

  it("leaves selections fully covering a token unchanged", () => {
    expect(
      expandInlineImageDeletion({
        text,
        start: tokenStart - 2,
        end: tokenEnd + 2,
        direction: "backward",
      }),
    ).toBeNull();
  });
});

describe("expandInlineImageDeletion inside-caret", () => {
  const token = "[image:abc12345]";
  const text = `before ${token} after`;
  const tokenStart = text.indexOf(token);
  const tokenEnd = tokenStart + token.length;

  it("swallows the token when the caret sits inside it", () => {
    const inside = tokenStart + 4;
    expect(
      expandInlineImageDeletion({
        text,
        start: inside,
        end: inside,
        direction: "backward",
      }),
    ).toEqual({ start: tokenStart, end: tokenEnd });
    expect(
      expandInlineImageDeletion({
        text,
        start: inside,
        end: inside,
        direction: "forward",
      }),
    ).toEqual({ start: tokenStart, end: tokenEnd });
  });
});

describe("snapInlineImageCaret", () => {
  const token = "[image:abc12345]";
  const text = `before ${token} after`;
  const tokenStart = text.indexOf(token);
  const tokenEnd = tokenStart + token.length;

  it("snaps a caret inside a token to the nearest boundary", () => {
    expect(snapInlineImageCaret(text, tokenStart + 2)).toBe(tokenStart);
    expect(snapInlineImageCaret(text, tokenEnd - 2)).toBe(tokenEnd);
  });

  it("leaves carets at boundaries and outside tokens alone", () => {
    expect(snapInlineImageCaret(text, tokenStart)).toBe(tokenStart);
    expect(snapInlineImageCaret(text, tokenEnd)).toBe(tokenEnd);
    expect(snapInlineImageCaret(text, 2)).toBe(2);
    expect(snapInlineImageCaret("no tokens", 3)).toBe(3);
  });
});

describe("isImageAttachmentAnchored", () => {
  it("detects a live token for the attachment", () => {
    const a = imageAttachment("att_aaa11111");
    const text = `see ${buildInlineImageToken("att_aaa11111")} here`;
    expect(isImageAttachmentAnchored(text, a as never, [a])).toBe(true);
    expect(isImageAttachmentAnchored("no token", a as never, [a])).toBe(false);
  });
});

describe("createInlineImageTextStore", () => {
  it("notifies subscribers on change only", () => {
    const store = createInlineImageTextStore("a");
    let calls = 0;
    const unsubscribe = store.subscribe(() => {
      calls += 1;
    });
    store.set("a");
    expect(calls).toBe(0);
    store.set("b");
    expect(store.get()).toBe("b");
    expect(calls).toBe(1);
    unsubscribe();
    store.set("c");
    expect(calls).toBe(1);
  });
});
