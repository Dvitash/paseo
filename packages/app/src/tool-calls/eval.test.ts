import { describe, expect, it } from "vitest";
import type { ToolCallDetail } from "@getpaseo/protocol/agent-types";
import { getEvalPresentation, normalizeLanguage } from "./eval";

describe("normalizeLanguage", () => {
  it("normalizes JavaScript aliases to 'js'", () => {
    expect(normalizeLanguage("js")).toBe("js");
    expect(normalizeLanguage("javascript")).toBe("js");
    expect(normalizeLanguage("JavaScript")).toBe("js");
    expect(normalizeLanguage("JS")).toBe("js");
  });

  it("normalizes Python aliases to 'py'", () => {
    expect(normalizeLanguage("py")).toBe("py");
    expect(normalizeLanguage("python")).toBe("py");
    expect(normalizeLanguage("python3")).toBe("py");
    expect(normalizeLanguage("Python")).toBe("py");
    expect(normalizeLanguage("PYTHON3")).toBe("py");
  });

  it("retains other explicit language strings without guessing", () => {
    expect(normalizeLanguage("typescript")).toBe("typescript");
    expect(normalizeLanguage("ts")).toBe("ts");
    expect(normalizeLanguage("bash")).toBe("bash");
    expect(normalizeLanguage("sh")).toBe("sh");
    expect(normalizeLanguage("sql")).toBe("sql");
  });

  it("returns null for missing, empty, or non-string language values", () => {
    expect(normalizeLanguage(null)).toBeNull();
    expect(normalizeLanguage(undefined)).toBeNull();
    expect(normalizeLanguage("")).toBeNull();
    expect(normalizeLanguage("   ")).toBeNull();
    expect(normalizeLanguage(123)).toBeNull();
    expect(normalizeLanguage({})).toBeNull();
  });
});

describe("getEvalPresentation", () => {
  describe("tool name matching and filtering", () => {
    const validDetail: ToolCallDetail = {
      type: "unknown",
      input: { language: "js", code: "console.log('hi')" },
      output: null,
    };

    it("matches exact 'eval' tool name", () => {
      const presentation = getEvalPresentation("eval", validDetail);
      expect(presentation).toEqual({
        title: null,
        cells: [
          {
            id: "cell-0",
            title: null,
            language: "js",
            code: "console.log('hi')",
            output: "",
          },
        ],
      });
    });

    it("matches 'functions.eval' tool name", () => {
      const presentation = getEvalPresentation("functions.eval", validDetail);
      expect(presentation).not.toBeNull();
      expect(presentation?.cells[0].code).toBe("console.log('hi')");
    });

    it("matches namespaced leaf eval like 'mcp__eval'", () => {
      const presentation = getEvalPresentation("mcp__eval", validDetail);
      expect(presentation).not.toBeNull();
      expect(presentation?.cells[0].code).toBe("console.log('hi')");
    });

    it("returns null for unrelated tool names", () => {
      expect(getEvalPresentation("bash", validDetail)).toBeNull();
      expect(getEvalPresentation("read", validDetail)).toBeNull();
      expect(getEvalPresentation("write", validDetail)).toBeNull();
      expect(getEvalPresentation("custom_eval", validDetail)).toBeNull();
      expect(getEvalPresentation("evaluate", validDetail)).toBeNull();
      expect(getEvalPresentation("browser_evaluate", validDetail)).toBeNull();
      expect(getEvalPresentation(undefined, validDetail)).toBeNull();
      expect(getEvalPresentation("", validDetail)).toBeNull();
    });
  });

  describe("malformed and unrelated payloads", () => {
    it("returns null if detail is undefined", () => {
      expect(getEvalPresentation("eval", undefined)).toBeNull();
    });

    it("returns null if detail type is not 'unknown'", () => {
      const shellDetail: ToolCallDetail = {
        type: "shell",
        command: "python -c 'print(1)'",
      };
      expect(getEvalPresentation("eval", shellDetail)).toBeNull();
    });

    it("returns null if detail input is missing or null", () => {
      const detail: ToolCallDetail = {
        type: "unknown",
        input: null,
        output: null,
      };
      expect(getEvalPresentation("eval", detail)).toBeNull();
    });

    it("returns null if input is not an object or valid JSON object", () => {
      expect(
        getEvalPresentation("eval", {
          type: "unknown",
          input: 42,
          output: null,
        }),
      ).toBeNull();

      expect(
        getEvalPresentation("eval", {
          type: "unknown",
          input: "invalid json string {",
          output: null,
        }),
      ).toBeNull();
    });

    it("returns null if input has no code or empty code", () => {
      expect(
        getEvalPresentation("eval", {
          type: "unknown",
          input: { language: "py" },
          output: null,
        }),
      ).toBeNull();

      expect(
        getEvalPresentation("eval", {
          type: "unknown",
          input: { language: "py", code: "" },
          output: null,
        }),
      ).toBeNull();

      expect(
        getEvalPresentation("eval", {
          type: "unknown",
          input: { language: "py", code: "   \n\t  " },
          output: null,
        }),
      ).toBeNull();
    });
  });

  describe("running input-only", () => {
    it("presents running tool call with null output as a single cell with empty output", () => {
      const detail: ToolCallDetail = {
        type: "unknown",
        input: {
          language: "py",
          code: "import time\ntime.sleep(5)",
          title: "Waiting",
        },
        output: null,
      };

      const presentation = getEvalPresentation("eval", detail);
      expect(presentation).toEqual({
        title: "Waiting",
        cells: [
          {
            id: "cell-0",
            title: "Waiting",
            language: "py",
            code: "import time\ntime.sleep(5)",
            output: "",
          },
        ],
      });
    });

    it("handles undefined output when tool call is pending", () => {
      const detail: ToolCallDetail = {
        type: "unknown",
        input: {
          language: "javascript",
          code: "await fetch('/api/data')",
        },
        output: undefined,
      };

      const presentation = getEvalPresentation("eval", detail);
      expect(presentation).toEqual({
        title: null,
        cells: [
          {
            id: "cell-0",
            title: null,
            language: "js",
            code: "await fetch('/api/data')",
            output: "",
          },
        ],
      });
    });
  });

  describe("null and omitted language handling", () => {
    it("sets cell language to null when input language is omitted or null", () => {
      const detail: ToolCallDetail = {
        type: "unknown",
        input: {
          code: "print('hello')",
        },
        output: "hello\n",
      };

      const presentation = getEvalPresentation("eval", detail);
      expect(presentation).toEqual({
        title: null,
        cells: [
          {
            id: "cell-0",
            title: null,
            language: null,
            code: "print('hello')",
            output: "hello\n",
          },
        ],
      });
    });
  });

  describe("multiple structured cells", () => {
    it("extracts multiple structured cells from details.cells", () => {
      const detail: ToolCallDetail = {
        type: "unknown",
        input: {
          language: "py",
          code: "x = 1\ny = 2",
          title: "Setup and Compute",
        },
        output: {
          details: {
            title: "Execution Run",
            language: "py",
            cells: [
              {
                index: 0,
                title: "Setup",
                code: "x = 1",
                language: "python",
                output: "initialized x\n",
                status: "completed",
              },
              {
                index: 1,
                title: "Compute",
                code: "y = 2",
                language: "python",
                output: "initialized y\n",
                status: "completed",
              },
            ],
          },
        },
      };

      const presentation = getEvalPresentation("eval", detail);
      expect(presentation).toEqual({
        title: "Execution Run",
        cells: [
          {
            id: "cell-0",
            title: "Setup",
            language: "py",
            code: "x = 1",
            output: "initialized x\n",
          },
          {
            id: "cell-1",
            title: "Compute",
            language: "py",
            code: "y = 2",
            output: "initialized y\n",
          },
        ],
      });
    });

    it("preserves explicit blank output on structured cells", () => {
      const detail: ToolCallDetail = {
        type: "unknown",
        input: {
          language: "py",
          code: "pass",
        },
        output: {
          details: {
            cells: [
              {
                id: "silent-cell",
                code: "pass",
                output: "",
              },
            ],
          },
        },
      };

      const presentation = getEvalPresentation("eval", detail);
      expect(presentation).toEqual({
        title: null,
        cells: [
          {
            id: "silent-cell",
            title: null,
            language: "py",
            code: "pass",
            output: "",
          },
        ],
      });
    });
  });

  describe("screenshot payload", () => {
    it("extracts text alongside image without including or corrupting the image payload", () => {
      const detail: ToolCallDetail = {
        type: "unknown",
        input: {
          language: "js",
          code: "await page.screenshot()",
        },
        output: {
          content: [
            {
              type: "text",
              text: "Screenshot captured: 1920x1080\n",
            },
            {
              type: "image",
              data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk",
              mimeType: "image/png",
            },
          ],
        },
      };

      const presentation = getEvalPresentation("eval", detail);
      expect(presentation).toEqual({
        title: null,
        cells: [
          {
            id: "cell-0",
            title: null,
            language: "js",
            code: "await page.screenshot()",
            output: "Screenshot captured: 1920x1080\n",
          },
        ],
      });
    });

    it("preserves blank output when screenshot payload contains no text blocks", () => {
      const detail: ToolCallDetail = {
        type: "unknown",
        input: {
          language: "js",
          code: "await page.screenshot()",
        },
        output: {
          content: [
            {
              type: "image",
              data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk",
              mimeType: "image/png",
            },
          ],
        },
      };

      const presentation = getEvalPresentation("eval", detail);
      expect(presentation).toEqual({
        title: null,
        cells: [
          {
            id: "cell-0",
            title: null,
            language: "js",
            code: "await page.screenshot()",
            output: "",
          },
        ],
      });
    });
  });

  describe("errors as text output", () => {
    it("extracts error from content text blocks", () => {
      const detail: ToolCallDetail = {
        type: "unknown",
        input: {
          language: "py",
          code: "1 / 0",
        },
        output: {
          isError: true,
          content: [
            {
              type: "text",
              text: "ZeroDivisionError: division by zero",
            },
          ],
        },
      };

      const presentation = getEvalPresentation("eval", detail);
      expect(presentation).toEqual({
        title: null,
        cells: [
          {
            id: "cell-0",
            title: null,
            language: "py",
            code: "1 / 0",
            output: "ZeroDivisionError: division by zero",
            error: {
              message: "ZeroDivisionError: division by zero",
              details: "ZeroDivisionError: division by zero",
            },
          },
        ],
        error: {
          message: "ZeroDivisionError: division by zero",
          details: "ZeroDivisionError: division by zero",
        },
      });
    });

    it("extracts error message from error object payload", () => {
      const detail: ToolCallDetail = {
        type: "unknown",
        input: {
          language: "js",
          code: "unknownFunc()",
        },
        output: {
          error: {
            message: "ReferenceError: unknownFunc is not defined",
          },
        },
      };

      const presentation = getEvalPresentation("eval", detail);
      expect(presentation).toEqual({
        title: null,
        cells: [
          {
            id: "cell-0",
            title: null,
            language: "js",
            code: "unknownFunc()",
            output: "ReferenceError: unknownFunc is not defined",
            error: {
              message: "ReferenceError: unknownFunc is not defined",
              details: "ReferenceError: unknownFunc is not defined",
            },
          },
        ],
        error: {
          message: "ReferenceError: unknownFunc is not defined",
          details: "ReferenceError: unknownFunc is not defined",
        },
      });
    });

    it("preserves stderr text from content when structured cells are present without duplicating existing output", () => {
      const detail: ToolCallDetail = {
        type: "unknown",
        input: {
          language: "py",
          code: "import sys\nprint('out')\nprint('err', file=sys.stderr)",
        },
        output: {
          content: [
            {
              type: "text",
              text: "out\n",
            },
            {
              type: "text",
              text: "err\n",
            },
          ],
          details: {
            cells: [
              {
                index: 0,
                code: "print('out')",
                output: "out\n",
              },
            ],
          },
        },
      };

      const presentation = getEvalPresentation("eval", detail);
      expect(presentation).toEqual({
        title: null,
        cells: [
          {
            id: "cell-0",
            title: null,
            language: "py",
            code: "print('out')",
            output: "out\nerr\n",
          },
        ],
      });
    });
  });

  describe("JSON-encoded inputs and outputs", () => {
    it.each([
      { language: "py", code: 'text = "first\\nsecond"\nprint(text)' },
      { language: "js", code: 'const text = "first\\nsecond";\nconsole.log(text);' },
    ])("decodes $language line breaks without unescaping source literals", ({ language, code }) => {
      for (const input of [{ language, code }, JSON.stringify({ language, code })]) {
        const presentation = getEvalPresentation("eval", {
          type: "unknown",
          input,
          output: null,
        });
        expect(presentation?.cells[0].code).toBe(code);
        expect(presentation?.cells[0].code.split("\n")).toHaveLength(2);
      }
    });

    it("does not guess that literal backslash-n characters need another decoding pass", () => {
      const code = String.raw`import time\ntime.sleep(1)`;
      const presentation = getEvalPresentation("eval", {
        type: "unknown",
        input: JSON.stringify({ language: "py", code }),
        output: null,
      });
      expect(presentation?.cells[0].code).toBe(code);
      expect(presentation?.cells[0].code).not.toContain("\n");
    });

    it("handles JSON-string encoded input and output", () => {
      const detail: ToolCallDetail = {
        type: "unknown",
        input: JSON.stringify({
          language: "js",
          code: "const sum = 1 + 2;\nsum;",
          title: "Math operation",
        }),
        output: JSON.stringify({
          content: [
            {
              type: "text",
              text: "3",
            },
          ],
        }),
      };

      const presentation = getEvalPresentation("eval", detail);
      expect(presentation).toEqual({
        title: "Math operation",
        cells: [
          {
            id: "cell-0",
            title: "Math operation",
            language: "js",
            code: "const sum = 1 + 2;\nsum;",
            output: "3",
          },
        ],
      });
    });

    it("preserves raw JSON-looking output string when not a recognized eval envelope", () => {
      const detail: ToolCallDetail = {
        type: "unknown",
        input: {
          language: "py",
          code: "import json\nprint(json.dumps({'foo': 1}))",
        },
        output: '{"foo":1}',
      };

      const presentation = getEvalPresentation("eval", detail);
      expect(presentation).toEqual({
        title: null,
        cells: [
          {
            id: "cell-0",
            title: null,
            language: "py",
            code: "import json\nprint(json.dumps({'foo': 1}))",
            output: '{"foo":1}',
          },
        ],
      });
    });

    it("preserves array JSON-looking output string", () => {
      const detail: ToolCallDetail = {
        type: "unknown",
        input: {
          language: "js",
          code: "[1, 2, 3]",
        },
        output: "[1, 2, 3]",
      };

      const presentation = getEvalPresentation("eval", detail);
      expect(presentation?.cells[0].output).toBe("[1, 2, 3]");
    });
  });

  describe("content blocks separation", () => {
    it("separates multiple content text blocks with newlines", () => {
      const detail: ToolCallDetail = {
        type: "unknown",
        input: {
          language: "py",
          code: "print('alpha')\nprint('beta')",
        },
        output: {
          content: [
            { type: "text", text: "alpha" },
            { type: "text", text: "beta" },
          ],
        },
      };

      const presentation = getEvalPresentation("eval", detail);
      expect(presentation?.cells[0].output).toBe("alpha\nbeta");
    });
  });

  describe("non-primitive output handling", () => {
    it("does not fabricate [object Object] when cell output is an object", () => {
      const detail: ToolCallDetail = {
        type: "unknown",
        input: {
          language: "js",
          code: "const o = { a: 1 };",
        },
        output: {
          details: {
            cells: [
              {
                index: 0,
                code: "const o = { a: 1 };",
                output: { unexpected: "object" },
              },
            ],
          },
        },
      };

      const presentation = getEvalPresentation("eval", detail);
      expect(presentation?.cells[0].output).toBe("");
    });
  });

  describe("normalized error handling and provider errors", () => {
    it("accepts provider error as optional third argument and attaches normalized metadata", () => {
      const detail: ToolCallDetail = {
        type: "unknown",
        input: {
          language: "js",
          code: "const x = undefinedVariable.val;",
        },
        output: "",
      };

      const rawProviderError =
        "ReferenceError: undefinedVariable is not defined\n    at eval (<anonymous>:1:11)";
      const presentation = getEvalPresentation("eval", detail, rawProviderError);

      expect(presentation).not.toBeNull();
      expect(presentation?.error).toEqual({
        message: "ReferenceError: undefinedVariable is not defined",
        details: rawProviderError,
      });
      expect(presentation?.cells[0].error).toEqual({
        message: "ReferenceError: undefinedVariable is not defined",
        details: rawProviderError,
      });
    });

    it("normalizes nested screenshot error from Error: { ... } at <anonymous> without embedding opaque JSON", () => {
      const nestedPayload = `Error: {"ok":false,"bridge":"ok","error":"user_code:1: Paid pass: DoubleCoins\\nuser_code:1 (at end of input)","output":[]}\n    at <anonymous> (js-cell-example.js:6:16)`;
      const detail: ToolCallDetail = {
        type: "unknown",
        input: {
          language: "js",
          code: "checkPass()",
        },
        output: "",
      };

      const presentation = getEvalPresentation("eval", detail, nestedPayload);
      expect(presentation).not.toBeNull();
      expect(presentation?.cells[0].output).toBe("");
      expect(presentation?.cells[0].error).toEqual({
        message: "Paid pass: DoubleCoins",
        details:
          "user_code:1: Paid pass: DoubleCoins\nuser_code:1 (at end of input)\n    at <anonymous> (js-cell-example.js:6:16)",
      });
      expect(presentation?.error).toEqual({
        message: "Paid pass: DoubleCoins",
        details:
          "user_code:1: Paid pass: DoubleCoins\nuser_code:1 (at end of input)\n    at <anonymous> (js-cell-example.js:6:16)",
      });
    });

    it("normalizes stringified content envelope wrapping nested screenshot error", () => {
      const nestedPayload = `Error: {"ok":false,"bridge":"ok","error":"user_code:1: Paid pass: DoubleCoins\\nuser_code:1 (at end of input)","output":[]}\n    at <anonymous> (js-cell-example.js:6:16)`;
      const detail: ToolCallDetail = {
        type: "unknown",
        input: {
          language: "js",
          code: "checkPass()",
        },
        output: JSON.stringify({
          content: [
            {
              type: "text",
              text: nestedPayload,
            },
          ],
          isError: true,
        }),
      };

      const presentation = getEvalPresentation("eval", detail);
      expect(presentation).not.toBeNull();
      expect(presentation?.cells[0].output).toBe("");
      expect(presentation?.cells[0].error?.message).toBe("Paid pass: DoubleCoins");
      expect(presentation?.cells[0].error?.details).toContain(
        "user_code:1: Paid pass: DoubleCoins",
      );
      expect(presentation?.cells[0].error?.details).toContain(
        "    at <anonymous> (js-cell-example.js:6:16)",
      );
      expect(presentation?.error?.message).toBe("Paid pass: DoubleCoins");
    });

    it("assigns failure to correct cell in multi-cell evaluation while preserving normal outputs", () => {
      const detail: ToolCallDetail = {
        type: "unknown",
        input: {
          language: "py",
          code: "# multiple cells",
        },
        output: {
          details: {
            cells: [
              {
                index: 0,
                code: "print('step 1: ok')",
                output: "step 1: ok\n",
              },
              {
                index: 1,
                code: "1 / 0",
                output: "ZeroDivisionError: division by zero",
                error: "ZeroDivisionError: division by zero",
              },
              {
                index: 2,
                code: "print('step 3: skipped')",
                output: "",
              },
            ],
          },
        },
      };

      const presentation = getEvalPresentation("eval", detail);
      expect(presentation).not.toBeNull();
      expect(presentation?.cells).toHaveLength(3);

      // Cell 0: Success, output preserved, no error
      expect(presentation?.cells[0].output).toBe("step 1: ok\n");
      expect(presentation?.cells[0].error).toBeUndefined();

      // Cell 1: Failure assigned to this cell
      expect(presentation?.cells[1].output).toBe("ZeroDivisionError: division by zero");
      expect(presentation?.cells[1].error).toEqual({
        message: "ZeroDivisionError: division by zero",
        details: "ZeroDivisionError: division by zero",
      });

      // Cell 2: No output, no error
      expect(presentation?.cells[2].output).toBe("");
      expect(presentation?.cells[2].error).toBeUndefined();

      // Presentation aggregate error
      expect(presentation?.error).toEqual({
        message: "ZeroDivisionError: division by zero",
        details: "ZeroDivisionError: division by zero",
      });
    });

    it("propagates provider error in multi-cell eval to the failing cell", () => {
      const detail: ToolCallDetail = {
        type: "unknown",
        input: {
          language: "js",
          code: "// multi-cell",
        },
        output: {
          details: {
            cells: [
              {
                index: 0,
                code: "console.log('init')",
                output: "init\n",
              },
              {
                index: 1,
                status: "failed",
                code: "throw new Error('boom')",
                output: "",
              },
            ],
          },
        },
      };

      const providerError = "Error: boom\n    at runner.js:10:5";
      const presentation = getEvalPresentation("eval", detail, providerError);

      expect(presentation).not.toBeNull();
      expect(presentation?.cells[0].error).toBeUndefined();
      expect(presentation?.cells[0].output).toBe("init\n");

      expect(presentation?.cells[1].error).toEqual({
        message: "boom",
        details: providerError,
      });
      expect(presentation?.error).toEqual({
        message: "boom",
        details: providerError,
      });
    });

    it("handles boolean error flag alone without rendering true or [object Object]", () => {
      const detail: ToolCallDetail = {
        type: "unknown",
        input: {
          language: "js",
          code: "doSomething()",
        },
        output: {
          isError: true,
        },
      };

      const presentation = getEvalPresentation("eval", detail);
      expect(presentation).not.toBeNull();
      expect(presentation?.cells[0].output).toBe("");
      expect(presentation?.cells[0].error).toEqual({
        message: "Evaluation failed",
        details: "Evaluation failed",
      });
      expect(presentation?.error).toEqual({
        message: "Evaluation failed",
        details: "Evaluation failed",
      });
    });

    it("does not treat error: false as a failure", () => {
      const detail: ToolCallDetail = {
        type: "unknown",
        input: {
          language: "js",
          code: "console.log('done')",
        },
        output: {
          output: "done\n",
          error: false,
        },
      };

      const presentation = getEvalPresentation("eval", detail);
      expect(presentation).not.toBeNull();
      expect(presentation?.cells[0].output).toBe("done\n");
      expect(presentation?.cells[0].error).toBeUndefined();
      expect(presentation?.error).toBeUndefined();
    });

    it("preserves literal 'true' and 'false' stdout without treating them as errors", () => {
      const detailTrue: ToolCallDetail = {
        type: "unknown",
        input: { language: "js", code: "console.log(true)" },
        output: "true\n",
      };
      const presentationTrue = getEvalPresentation("eval", detailTrue);
      expect(presentationTrue?.cells[0].output).toBe("true\n");
      expect(presentationTrue?.cells[0].error).toBeUndefined();
      expect(presentationTrue?.error).toBeUndefined();

      const detailFalse: ToolCallDetail = {
        type: "unknown",
        input: { language: "js", code: "console.log(false)" },
        output: "false\n",
      };
      const presentationFalse = getEvalPresentation("eval", detailFalse);
      expect(presentationFalse?.cells[0].output).toBe("false\n");
      expect(presentationFalse?.cells[0].error).toBeUndefined();
      expect(presentationFalse?.error).toBeUndefined();
    });

    it("does not classify successful printed Error stack string as failure", () => {
      const printedStack = "Error: printed message\n    at customLogger (logger.js:5:12)";
      const detail: ToolCallDetail = {
        type: "unknown",
        input: { language: "js", code: "console.log(stack)" },
        output: printedStack,
      };
      const presentation = getEvalPresentation("eval", detail);
      expect(presentation?.cells[0].output).toBe(printedStack);
      expect(presentation?.cells[0].error).toBeUndefined();
      expect(presentation?.error).toBeUndefined();
    });

    it("does not classify successful JSON containing error or ok fields as failure", () => {
      const successJson = '{"ok":true,"error":null,"count":1}';
      const detail: ToolCallDetail = {
        type: "unknown",
        input: { language: "js", code: "console.log(JSON.stringify(res))" },
        output: successJson,
      };
      const presentation = getEvalPresentation("eval", detail);
      expect(presentation?.cells[0].output).toBe(successJson);
      expect(presentation?.cells[0].error).toBeUndefined();
      expect(presentation?.error).toBeUndefined();
    });

    it("uses useful message from cell output when cell.error is boolean true", () => {
      const detail: ToolCallDetail = {
        type: "unknown",
        input: { language: "py", code: "1 / 0" },
        output: {
          details: {
            cells: [
              {
                index: 0,
                code: "1 / 0",
                output: "ZeroDivisionError: division by zero\n",
                error: true,
              },
            ],
          },
        },
      };
      const presentation = getEvalPresentation("eval", detail);
      expect(presentation?.cells[0].error).toEqual({
        message: "ZeroDivisionError: division by zero",
        details: "ZeroDivisionError: division by zero\n",
      });
      expect(presentation?.error?.message).toBe("ZeroDivisionError: division by zero");
    });

    it("retains prior stdout in error details when error envelope has output array", () => {
      const nestedWithStdout = `Error: {"ok":false,"bridge":"ok","error":"user_code:1: Paid pass: DoubleCoins\\nuser_code:1 (at end of input)","output":["Verifying pass...\\n"]}\n    at <anonymous> (test.js:1:1)`;
      const detail: ToolCallDetail = {
        type: "unknown",
        input: { language: "js", code: "check()" },
        output: nestedWithStdout,
      };
      const presentation = getEvalPresentation("eval", detail, true);
      expect(presentation?.cells[0].error?.message).toBe("Paid pass: DoubleCoins");
      expect(presentation?.cells[0].error?.details).toContain("Verifying pass...\n");
      expect(presentation?.cells[0].error?.details).toContain(
        "user_code:1: Paid pass: DoubleCoins",
      );
      expect(presentation?.cells[0].error?.details).toContain("    at <anonymous> (test.js:1:1)");
    });

    it("recurses through wrapped JSON context when cell.error is boolean true", () => {
      const wrappedJson = `Error: {"ok":false,"bridge":"ok","error":"user_code:1: Paid pass: DoubleCoins\\nuser_code:1 (at end of input)","output":[]}\n    at <anonymous> (js-cell-example.js:6:16)`;
      const detail: ToolCallDetail = {
        type: "unknown",
        input: { language: "js", code: "check()" },
        output: {
          details: {
            cells: [
              {
                index: 0,
                code: "check()",
                output: wrappedJson,
                error: true,
              },
            ],
          },
        },
      };

      const presentation = getEvalPresentation("eval", detail);
      expect(presentation?.cells[0].output).toBe("");
      expect(presentation?.cells[0].error).toEqual({
        message: "Paid pass: DoubleCoins",
        details:
          "user_code:1: Paid pass: DoubleCoins\nuser_code:1 (at end of input)\n    at <anonymous> (js-cell-example.js:6:16)",
      });
    });
  });
});
