import { describe, expect, it } from "vitest";
import { boundToolText } from "./preview";

describe("boundToolText", () => {
  describe("empty input and bounds", () => {
    it("returns empty string and not truncated for empty input", () => {
      expect(boundToolText("", 10, 100)).toEqual({
        text: "",
        truncated: false,
      });
    });

    it("returns empty string and not truncated for empty input even with zero or negative limits", () => {
      expect(boundToolText("", 0, 0)).toEqual({
        text: "",
        truncated: false,
      });
      expect(boundToolText("", -1, -5)).toEqual({
        text: "",
        truncated: false,
      });
    });

    it("truncates non-empty input to empty string when maxLines is zero or negative", () => {
      expect(boundToolText("hello world", 0, 100)).toEqual({
        text: "",
        truncated: true,
      });
      expect(boundToolText("hello world", -2, 100)).toEqual({
        text: "",
        truncated: true,
      });
    });

    it("truncates non-empty input to empty string when maxChars is zero or negative", () => {
      expect(boundToolText("hello world", 10, 0)).toEqual({
        text: "",
        truncated: true,
      });
      expect(boundToolText("hello world", 10, -10)).toEqual({
        text: "",
        truncated: true,
      });
    });
  });

  describe("line count bounds", () => {
    it("does not truncate text within maxLines", () => {
      const input = "line 1\nline 2\nline 3";
      expect(boundToolText(input, 5, 1000)).toEqual({
        text: "line 1\nline 2\nline 3",
        truncated: false,
      });
    });

    it("does not truncate text matching exact maxLines", () => {
      const input = "line 1\nline 2\nline 3";
      expect(boundToolText(input, 3, 1000)).toEqual({
        text: "line 1\nline 2\nline 3",
        truncated: false,
      });
    });

    it("truncates text when lines exceed maxLines", () => {
      const input = "line 1\nline 2\nline 3\nline 4";
      expect(boundToolText(input, 2, 1000)).toEqual({
        text: "line 1\nline 2",
        truncated: true,
      });
    });

    it("preserves leading and trailing whitespace on kept lines", () => {
      const input = "  \tconst a = 1;\n    const b = 2;\n    const c = 3;\n";
      expect(boundToolText(input, 2, 1000)).toEqual({
        text: "  \tconst a = 1;\n    const b = 2;",
        truncated: true,
      });
    });

    it("handles Windows carriage return newlines without leaving trailing carriage return", () => {
      const input = "first\r\nsecond\r\nthird";
      expect(boundToolText(input, 1, 1000)).toEqual({
        text: "first",
        truncated: true,
      });
      expect(boundToolText(input, 2, 1000)).toEqual({
        text: "first\r\nsecond",
        truncated: true,
      });
    });

    it("preserves Windows newlines when text is within bounds", () => {
      const input = "first\r\nsecond";
      expect(boundToolText(input, 2, 1000)).toEqual({
        text: "first\r\nsecond",
        truncated: false,
      });
    });
  });

  describe("long lines and character limits", () => {
    it("truncates single line exceeding maxChars", () => {
      const input = "abcdefghij";
      expect(boundToolText(input, 10, 5)).toEqual({
        text: "abcde",
        truncated: true,
      });
    });

    it("does not truncate single line within maxChars", () => {
      const input = "abcdefghij";
      expect(boundToolText(input, 10, 10)).toEqual({
        text: "abcdefghij",
        truncated: false,
      });
    });

    it("applies whichever limit is smaller between maxLines and maxChars", () => {
      const input = "12345\n67890\nabcde";
      // maxChars cuts before line 2 finishes
      expect(boundToolText(input, 2, 8)).toEqual({
        text: "12345\n67",
        truncated: true,
      });
      // maxLines cuts before maxChars is reached
      expect(boundToolText(input, 1, 100)).toEqual({
        text: "12345",
        truncated: true,
      });
    });

    it("bounds huge single line up to maxChars without processing whole string", () => {
      const input = "a".repeat(100_000);
      expect(boundToolText(input, 10, 50)).toEqual({
        text: "a".repeat(50),
        truncated: true,
      });
    });
  });

  describe("Unicode and surrogate pairs", () => {
    it("does not split surrogate pair when maxChars falls on high surrogate boundary", () => {
      // "😀" is represented by two 16-bit code units: \uD83D \uDE00
      const emoji = "😀";
      const input = `hello ${emoji} world`;
      // 'hello ' is 6 chars, emoji starts at index 6 and ends at index 8
      // If maxChars is 7, cutting at 7 would split the emoji
      const bounded = boundToolText(input, 10, 7);
      expect(bounded).toEqual({
        text: "hello ",
        truncated: true,
      });
    });

    it("keeps complete surrogate pair when maxChars includes both code units", () => {
      const emoji = "😀";
      const input = `hello ${emoji} world`;
      // maxChars is 8, includes both code units of emoji
      const bounded = boundToolText(input, 10, 8);
      expect(bounded).toEqual({
        text: `hello ${emoji}`,
        truncated: true,
      });
    });

    it("handles non-BMP Unicode characters correctly across multiline content", () => {
      // 𐍈 (Old Italic Ahe: \uD800\uDF48)
      const nonBmp = "𐍈";
      const input = `line1: ${nonBmp}\nline2: ${nonBmp}`;
      expect(boundToolText(input, 1, 100)).toEqual({
        text: `line1: ${nonBmp}`,
        truncated: true,
      });
    });
  });
});
