import { describe, expect, it } from "vitest";
import { isAdvisorToolCall, parseAdvisorComments, getAdvisorSeverityLabel } from "./advisor";

describe("isAdvisorToolCall", () => {
  it("returns true for synthetic omp_advisor tool calls with plain_text detail", () => {
    expect(
      isAdvisorToolCall({
        metadata: { source: "omp_advisor", synthetic: true },
        detail: { type: "plain_text", text: "[nit] Note" },
      }),
    ).toBe(true);
  });

  it("returns false if metadata source is not omp_advisor", () => {
    expect(
      isAdvisorToolCall({
        metadata: { source: "bash" },
        detail: { type: "plain_text", text: "Some output" },
      }),
    ).toBe(false);

    expect(
      isAdvisorToolCall({
        detail: { type: "plain_text", text: "Some output" },
      }),
    ).toBe(false);
  });

  it("returns false if detail type is not plain_text", () => {
    expect(
      isAdvisorToolCall({
        metadata: { source: "omp_advisor" },
        detail: { type: "plan", text: "Plan text" },
      }),
    ).toBe(false);

    expect(
      isAdvisorToolCall({
        metadata: { source: "omp_advisor" },
        detail: { type: "unknown", input: null, output: null },
      }),
    ).toBe(false);
  });

  it("returns false for null or undefined candidate", () => {
    expect(isAdvisorToolCall(null)).toBe(false);
    expect(isAdvisorToolCall(undefined)).toBe(false);
  });
});

describe("parseAdvisorComments", () => {
  describe("severity parsing", () => {
    it("parses nit severity", () => {
      const result = parseAdvisorComments("[nit] Consider simplifying this expression");
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        id: "advisor-comment-0",
        severity: "nit",
        advisor: undefined,
        text: "Consider simplifying this expression",
      });
    });

    it("parses concern severity", () => {
      const result = parseAdvisorComments("[concern] Potential null pointer dereference");
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        id: "advisor-comment-0",
        severity: "concern",
        advisor: undefined,
        text: "Potential null pointer dereference",
      });
    });

    it("parses blocker severity", () => {
      const result = parseAdvisorComments("[blocker] Broken build due to missing export");
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        id: "advisor-comment-0",
        severity: "blocker",
        advisor: undefined,
        text: "Broken build due to missing export",
      });
    });

    it("is case-insensitive for recognized severities", () => {
      const result = parseAdvisorComments(
        "[NIT] Uppercase nit\n\n[Concern] Capitalized concern\n\n[BLOCKER] Uppercase blocker",
      );
      expect(result).toHaveLength(3);
      expect(result[0]?.severity).toBe("nit");
      expect(result[1]?.severity).toBe("concern");
      expect(result[2]?.severity).toBe("blocker");
    });
  });

  describe("optional advisor attribution", () => {
    it("parses advisor tag after severity prefix", () => {
      const result = parseAdvisorComments("[nit] [review-bot] Use const instead of let");
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        id: "advisor-comment-0",
        severity: "nit",
        advisor: "review-bot",
        text: "Use const instead of let",
      });
    });

    it("parses advisor tag with concern and blocker", () => {
      const result = parseAdvisorComments(
        "[concern] [security] Potential injection vector\n\n[blocker] [compiler] Syntax error",
      );
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({
        id: "advisor-comment-0",
        severity: "concern",
        advisor: "security",
        text: "Potential injection vector",
      });
      expect(result[1]).toEqual({
        id: "advisor-comment-1",
        severity: "blocker",
        advisor: "compiler",
        text: "Syntax error",
      });
    });
  });

  describe("mixed notes", () => {
    it("splits multiple notes separated by blank lines followed by recognized prefixes", () => {
      const input = [
        "[nit] [style] Prefer optional chaining",
        "[concern] Missing unit tests for edge cases",
        "[blocker] Database connection string exposed",
      ].join("\n\n");

      const result = parseAdvisorComments(input);
      expect(result).toHaveLength(3);
      expect(result[0]).toMatchObject({
        severity: "nit",
        advisor: "style",
        text: "Prefer optional chaining",
      });
      expect(result[1]).toMatchObject({
        severity: "concern",
        text: "Missing unit tests for edge cases",
      });
      expect(result[2]).toMatchObject({
        severity: "blocker",
        text: "Database connection string exposed",
      });
    });
  });

  describe("multiline and continuation paragraph preservation", () => {
    it("preserves continuation paragraphs within a note without splitting them", () => {
      const input = `[concern] First paragraph explaining the problem.

Second paragraph with code sample or more details.

Third paragraph with suggested fix.

[nit] Another note that starts here.`;

      const result = parseAdvisorComments(input);
      expect(result).toHaveLength(2);

      expect(result[0]).toEqual({
        id: "advisor-comment-0",
        severity: "concern",
        advisor: undefined,
        text: "First paragraph explaining the problem.\n\nSecond paragraph with code sample or more details.\n\nThird paragraph with suggested fix.",
      });

      expect(result[1]).toEqual({
        id: "advisor-comment-1",
        severity: "nit",
        advisor: undefined,
        text: "Another note that starts here.",
      });
    });

    it("preserves single linebreaks within a note", () => {
      const input = "[nit] Line 1\nLine 2\nLine 3";
      const result = parseAdvisorComments(input);
      expect(result).toHaveLength(1);
      expect(result[0]?.text).toBe("Line 1\nLine 2\nLine 3");
    });
  });

  describe("neutral fallback", () => {
    it("preserves untyped plain text as neutral note", () => {
      const input = "Overall architecture looks great.\n\nBe mindful of cache invalidation.";
      const result = parseAdvisorComments(input);
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        id: "advisor-comment-0",
        severity: "neutral",
        text: input,
      });
    });

    it("treats unrecognized bracket tags as neutral intact text", () => {
      const input = "[info] Information level is not a recognized severity tag";
      const result = parseAdvisorComments(input);
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        id: "advisor-comment-0",
        severity: "neutral",
        text: input,
      });
    });

    it("handles neutral preamble followed by severity notes", () => {
      const input = `Here is some general feedback on your pull request:

[nit] Fix spelling in comment

[concern] Check error propagation`;

      const result = parseAdvisorComments(input);
      expect(result).toHaveLength(3);
      expect(result[0]).toEqual({
        id: "advisor-comment-0",
        severity: "neutral",
        text: "Here is some general feedback on your pull request:",
      });
      expect(result[1]).toMatchObject({
        severity: "nit",
        text: "Fix spelling in comment",
      });
      expect(result[2]).toMatchObject({
        severity: "concern",
        text: "Check error propagation",
      });
    });
  });

  describe("empty and edge case handling", () => {
    it("returns empty array for empty or whitespace strings", () => {
      expect(parseAdvisorComments("")).toEqual([]);
      expect(parseAdvisorComments("   \n\n  ")).toEqual([]);
      expect(parseAdvisorComments(undefined)).toEqual([]);
      expect(parseAdvisorComments(null)).toEqual([]);
    });

    it("handles notes with severity but empty body", () => {
      const result = parseAdvisorComments("[nit]");
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        id: "advisor-comment-0",
        severity: "nit",
        advisor: undefined,
        text: "",
      });
    });
  });
});

describe("getAdvisorSeverityLabel", () => {
  it.each([
    ["nit", "Nit"],
    ["concern", "Concern"],
    ["blocker", "Blocker"],
    ["neutral", "Note"],
  ] as const)("maps %s to %s", (severity, expected) => {
    expect(getAdvisorSeverityLabel(severity)).toBe(expected);
  });
});
