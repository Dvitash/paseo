import { describe, expect, it } from "vitest";
import {
  extractActionableErrorMessage,
  isScreenshotErrorEnvelope,
  normalizeEvalError,
  sanitizeOutputText,
} from "./eval-error";

describe("eval-error normalization", () => {
  describe("extractActionableErrorMessage", () => {
    it("extracts clean message from Luau user_code location prefix and parser noise", () => {
      const raw = "user_code:1: Paid pass: DoubleCoins\nuser_code:1 (at end of input)";
      expect(extractActionableErrorMessage(raw)).toBe("Paid pass: DoubleCoins");
    });

    it("extracts clean message from generic Error: prefix with location prefix", () => {
      const raw = "Error: user_code:1: Paid pass: DoubleCoins";
      expect(extractActionableErrorMessage(raw)).toBe("Paid pass: DoubleCoins");
    });

    it("preserves specific error class name for ReferenceError", () => {
      const raw =
        "ReferenceError: unknownEnvironment is not defined\n    at eval (<anonymous>:1:16)";
      expect(extractActionableErrorMessage(raw)).toBe(
        "ReferenceError: unknownEnvironment is not defined",
      );
    });

    it("preserves specific error class name for TypeError", () => {
      const raw =
        "TypeError: Cannot read properties of undefined (reading 'coins')\n    at process (eval.js:10:5)";
      expect(extractActionableErrorMessage(raw)).toBe(
        "TypeError: Cannot read properties of undefined (reading 'coins')",
      );
    });

    it("strips generic Error: prefix from standard Error", () => {
      const raw = "Error: Something failed\n    at run (test.js:2:1)";
      expect(extractActionableErrorMessage(raw)).toBe("Something failed");
    });

    it("extracts the actual exception from a multiline Python traceback", () => {
      const raw = `Traceback (most recent call last):
  File "<stdin>", line 1, in <module>
ZeroDivisionError: division by zero`;
      expect(extractActionableErrorMessage(raw)).toBe("ZeroDivisionError: division by zero");
    });

    it("preserves plain error text without Error prefix", () => {
      expect(extractActionableErrorMessage("Paid pass: DoubleCoins")).toBe(
        "Paid pass: DoubleCoins",
      );
    });

    it("returns empty string for boolean string values or object representations", () => {
      expect(extractActionableErrorMessage("true")).toBe("");
      expect(extractActionableErrorMessage("false")).toBe("");
      expect(extractActionableErrorMessage("[object Object]")).toBe("");
      expect(extractActionableErrorMessage("")).toBe("");
    });
  });

  describe("raw errors", () => {
    it("normalizes Error instance retaining full stack trace in details", () => {
      const error = new Error("Failed to execute");
      const normalized = normalizeEvalError(error);
      expect(normalized).not.toBeNull();
      expect(normalized?.message).toBe("Failed to execute");
      expect(normalized?.details).toContain("Failed to execute");
      expect(normalized?.details).toContain("Error: Failed to execute");
    });

    it("normalizes ReferenceError string retaining complete trace in details", () => {
      const raw =
        "ReferenceError: unknownFunc is not defined\n    at eval (<anonymous>:1:16)\n    at evaluate (runner.js:42:10)";
      const normalized = normalizeEvalError(raw);
      expect(normalized).toEqual({
        message: "ReferenceError: unknownFunc is not defined",
        details: raw,
      });
    });
  });

  describe("nested and screenshot errors", () => {
    it("normalizes nested screenshot error from Error: { ... } at <anonymous> pattern", () => {
      const raw = `Error: {"ok":false,"bridge":"ok","error":"user_code:1: Paid pass: DoubleCoins\\nuser_code:1 (at end of input)","output":[]}\n    at <anonymous> (js-cell-example.js:6:16)`;
      const normalized = normalizeEvalError(raw);
      expect(normalized).toEqual({
        message: "Paid pass: DoubleCoins",
        details:
          "user_code:1: Paid pass: DoubleCoins\nuser_code:1 (at end of input)\n    at <anonymous> (js-cell-example.js:6:16)",
      });
    });

    it("retains preceding stdout and details when stdout is present in output array", () => {
      const raw = `Error: {"ok":false,"bridge":"ok","error":"user_code:1: Paid pass: DoubleCoins\\nuser_code:1 (at end of input)","output":["Verifying pass...\\n","Checking pass...\\n"]}\n    at <anonymous> (js-cell-example.js:6:16)`;
      const normalized = normalizeEvalError(raw);
      expect(normalized?.message).toBe("Paid pass: DoubleCoins");
      expect(normalized?.details).toContain("Verifying pass...\nChecking pass...\n");
      expect(normalized?.details).toContain("    at <anonymous> (js-cell-example.js:6:16)");
    });
  });

  describe("stringified envelopes", () => {
    it("normalizes JSON-stringified content envelope wrapping nested screenshot error", () => {
      const nested = `Error: {"ok":false,"bridge":"ok","error":"user_code:1: Paid pass: DoubleCoins\\nuser_code:1 (at end of input)","output":[]}\n    at <anonymous> (js-cell-example.js:6:16)`;
      const envelope = JSON.stringify({
        content: [
          {
            type: "text",
            text: nested,
          },
        ],
        isError: true,
      });

      const normalized = normalizeEvalError(envelope);
      expect(normalized).toEqual({
        message: "Paid pass: DoubleCoins",
        details:
          "user_code:1: Paid pass: DoubleCoins\nuser_code:1 (at end of input)\n    at <anonymous> (js-cell-example.js:6:16)",
      });
    });

    it("normalizes stringified { ok: false, error: ... } object", () => {
      const envelope = JSON.stringify({
        ok: false,
        error: "user_code:1: Paid pass: DoubleCoins",
      });
      const normalized = normalizeEvalError(envelope);
      expect(normalized).toEqual({
        message: "Paid pass: DoubleCoins",
        details: "user_code:1: Paid pass: DoubleCoins",
      });
    });
  });

  describe("malformed JSON and resilience", () => {
    it("does not throw on truncated JSON error string and extracts actionable error", () => {
      const malformed =
        'Error: {"ok":false,"error":"user_code:1: Paid pass: DoubleCoins\\nuser_code:1 (at end of input)"';
      const normalized = normalizeEvalError(malformed);
      expect(normalized).not.toBeNull();
      expect(normalized?.message).toBe("Paid pass: DoubleCoins");
    });

    it("does not throw on broken JSON content envelope", () => {
      const broken = '{"content":[{"type":"text","text":"truncated';
      const normalized = normalizeEvalError(broken);
      expect(normalized).not.toBeNull();
      expect(normalized?.details).toBe(broken);
    });
  });

  describe("boolean error flags and edge cases", () => {
    it("handles boolean true error flag without rendering true or [object Object]", () => {
      const normalized = normalizeEvalError(true);
      expect(normalized).toEqual({
        message: "Evaluation failed",
        details: "Evaluation failed",
      });
    });

    it("extracts real failure message from context output when error is boolean true", () => {
      const context = "ZeroDivisionError: division by zero\n";
      const normalized = normalizeEvalError(true, context);
      expect(normalized).toEqual({
        message: "ZeroDivisionError: division by zero",
        details: context,
      });
    });

    it("returns null for boolean false", () => {
      expect(normalizeEvalError(false)).toBeNull();
    });

    it("returns null for null or undefined", () => {
      expect(normalizeEvalError(null)).toBeNull();
      expect(normalizeEvalError(undefined)).toBeNull();
    });

    it("handles { isError: true } object without explicit message", () => {
      const normalized = normalizeEvalError({ isError: true });
      expect(normalized).toEqual({
        message: "Evaluation failed",
        details: "Evaluation failed",
      });
    });

    it("extracts real failure message from context output when object has isError: true", () => {
      const context = "ReferenceError: foo is not defined\n";
      const normalized = normalizeEvalError({ isError: true }, context);
      expect(normalized).toEqual({
        message: "ReferenceError: foo is not defined",
        details: context,
      });
    });

    it("handles { error: true } object with context message", () => {
      const context = "TypeError: bar is not a function\n";
      const normalized = normalizeEvalError({ error: true }, context);
      expect(normalized).toEqual({
        message: "TypeError: bar is not a function",
        details: context,
      });
    });
  });

  describe("isScreenshotErrorEnvelope", () => {
    it("returns true only for error envelopes matching the screenshot format", () => {
      expect(isScreenshotErrorEnvelope('Error: {"ok":false,"bridge":"ok"}')).toBe(true);
      expect(isScreenshotErrorEnvelope('{"ok":false,"error":"bad"}')).toBe(true);
      expect(isScreenshotErrorEnvelope('{"ok":true,"error":null}')).toBe(false);
      expect(isScreenshotErrorEnvelope("hello world")).toBe(false);
      expect(isScreenshotErrorEnvelope("true")).toBe(false);
      expect(isScreenshotErrorEnvelope("")).toBe(false);
    });
  });

  describe("sanitizeOutputText", () => {
    it("returns string as-is and empty string for non-strings", () => {
      expect(sanitizeOutputText("hello")).toBe("hello");
      expect(sanitizeOutputText("true")).toBe("true");
      expect(sanitizeOutputText("false")).toBe("false");
      expect(sanitizeOutputText(123)).toBe("");
      expect(sanitizeOutputText(null)).toBe("");
    });
  });
});
