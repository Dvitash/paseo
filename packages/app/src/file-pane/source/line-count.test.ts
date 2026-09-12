import { describe, expect, it } from "vitest";
import { countContentLines } from "./line-count";

describe("countContentLines", () => {
  it("counts an empty document as one line", () => {
    expect(countContentLines("")).toBe(1);
  });

  it("counts a trailing newline as starting an empty final line", () => {
    expect(countContentLines("first\nsecond\n")).toBe(3);
  });

  it("counts consecutive newlines as empty lines", () => {
    expect(countContentLines("first\n\nthird")).toBe(3);
  });

  it("counts only line feeds, so CRLF and lone CR do not add lines", () => {
    expect(countContentLines("first\r\nsecond\r\n")).toBe(3);
    expect(countContentLines("first\rsecond")).toBe(1);
  });

  it("matches split-based counting for mixed documents", () => {
    const documents = [
      "\n",
      "\n\n",
      "one\r\ntwo\nthree",
      "alpha\r\nbeta\ngamma\r\n",
      "\nleading",
      "trailing\n\ttab\n",
      "plain source\n".repeat(250),
    ];
    for (const content of documents) {
      expect(countContentLines(content)).toBe(content.split("\n").length);
    }
  });
});
