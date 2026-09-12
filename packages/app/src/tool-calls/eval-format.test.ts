import { describe, expect, it } from "vitest";
import { canFormatEvalCode, formatEvalCode, MAX_EVAL_FORMAT_CHARS } from "./eval-format";

describe("formatEvalCode", () => {
  it("formats multiple JavaScript statements and nested objects into readable source", async () => {
    const source =
      'var id="studio-1";const payload={path:"Workspace",properties:{Anchored:true,Name:"Example"}};await tool.write(payload);';
    const formatted = await formatEvalCode(source, "js");
    expect(source).not.toContain("\n");
    expect(formatted).toContain('var id = "studio-1";\n');
    expect(formatted).toContain('  path: "Workspace",\n');
    expect(formatted).toContain("await tool.write(payload);");
    expect(formatted.split("\n").length).toBeGreaterThan(5);
  });

  it("preserves embedded source strings rather than reformatting their contents", async () => {
    const source = "const luau=`local x = 1; print(x)`;console.log(luau);";
    expect(await formatEvalCode(source, "js")).toContain("`local x = 1; print(x)`");
  });

  it("preserves escaped newlines inside strings while formatting actual source lines", async () => {
    const source = 'const text="first\\nsecond";\nconsole.log(text);';
    const formatted = await formatEvalCode(source, "js");
    expect(formatted).toBe('const text = "first\\nsecond";\nconsole.log(text);\n');
  });

  it("supports top-level await and return accepted by eval", async () => {
    const source = "const result=await Promise.resolve(1);return result;";
    expect(await formatEvalCode(source, "js")).toBe(
      "const result = await Promise.resolve(1);\nreturn result;\n",
    );
  });

  it("formats TypeScript without removing type annotations", async () => {
    expect(await formatEvalCode("const count:number=1;display(count);", "ts")).toBe(
      "const count: number = 1;\ndisplay(count);\n",
    );
  });

  it("preserves Python indentation, blank lines, and trailing whitespace exactly", async () => {
    const python = "def f():\n    return 1\n\nprint(f())  \n";
    expect(await formatEvalCode(python, "py")).toBe(python);
    expect(canFormatEvalCode(python, "py")).toBe(false);
  });

  it("preserves incomplete or malformed code", async () => {
    const source = "const value = { unfinished:";
    expect(await formatEvalCode(source, "js")).toBe(source);
  });

  it("does not execute code while formatting", async () => {
    const source = 'throw new Error("must not execute");';
    expect(await formatEvalCode(source, "js")).toContain('throw new Error("must not execute");');
  });

  it("avoids parsing oversized inputs and unsupported languages", async () => {
    const oversized = "x".repeat(MAX_EVAL_FORMAT_CHARS + 1);
    expect(canFormatEvalCode(oversized, "js")).toBe(false);
    expect(await formatEvalCode(oversized, "js")).toBe(oversized);
    expect(await formatEvalCode("a = b", null)).toBe("a = b");
  });
});
