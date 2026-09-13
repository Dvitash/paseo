import { describe, expect, it } from "vitest";
import MarkdownIt from "markdown-it";
import { markdownMathPlugin } from "./markdown-math-plugin";

describe("markdownMathPlugin", () => {
  function createParser() {
    const md = new MarkdownIt({ html: false });
    md.use(markdownMathPlugin);
    return md;
  }

  it("parses single inline math expressions", () => {
    const md = createParser();
    const tokens = md.parse("scalar component $w$.", {});
    const inline = tokens.find((t) => t.type === "inline");
    const mathTokens = inline?.children?.filter((c) => c.type === "math_inline");

    expect(mathTokens).toHaveLength(1);
    expect(mathTokens?.[0]?.content).toBe("w");
  });

  it("parses multiple inline math expressions with LaTeX syntax", () => {
    const md = createParser();
    const tokens = md.parse("ratio $360 / (2\\pi \\cdot 4)$ and $14.34^\\circ/\\text{stud}$", {});
    const inline = tokens.find((t) => t.type === "inline");
    const mathTokens = inline?.children?.filter((c) => c.type === "math_inline");

    expect(mathTokens).toHaveLength(2);
    expect(mathTokens?.[0]?.content).toBe("360 / (2\\pi \\cdot 4)");
    expect(mathTokens?.[1]?.content).toBe("14.34^\\circ/\\text{stud}");
  });

  it("does not parse currency as math", () => {
    const md = createParser();
    const tokens = md.parse("I have $50 and you have $100.", {});
    const inline = tokens.find((t) => t.type === "inline");
    const mathTokens = inline?.children?.filter((c) => c.type === "math_inline");

    expect(mathTokens).toHaveLength(0);
  });

  it("does not parse multi-currency lists as math", () => {
    const md = createParser();
    const tokens = md.parse("costs $10, $20, and $30", {});
    const inline = tokens.find((t) => t.type === "inline");
    const mathTokens = inline?.children?.filter((c) => c.type === "math_inline");

    expect(mathTokens).toHaveLength(0);
  });

  it("does not parse currency across lines as math", () => {
    const md = createParser();
    const tokens = md.parse("costs $50\nand $100", {});
    const inline = tokens.find((t) => t.type === "inline");
    const mathTokens = inline?.children?.filter((c) => c.type === "math_inline");

    expect(mathTokens).toHaveLength(0);
  });

  it("respects escaped dollar signs", () => {
    const md = createParser();
    const tokens = md.parse("an escaped \\$100 price", {});
    const inline = tokens.find((t) => t.type === "inline");
    const mathTokens = inline?.children?.filter((c) => c.type === "math_inline");

    expect(mathTokens).toHaveLength(0);
  });

  it("does not treat empty $$ as inline math", () => {
    const md = createParser();
    const tokens = md.parse("empty $$ here", {});
    const inline = tokens.find((t) => t.type === "inline");
    const mathTokens = inline?.children?.filter((c) => c.type === "math_inline");

    expect(mathTokens).toHaveLength(0);
  });

  it("parses single-line math block", () => {
    const md = createParser();
    const tokens = md.parse("$$E = mc^2$$", {});

    expect(tokens).toHaveLength(1);
    expect(tokens[0]?.type).toBe("math_block");
    expect(tokens[0]?.content.trim()).toBe("E = mc^2");
  });

  it("parses multi-line math block", () => {
    const md = createParser();
    const tokens = md.parse("$$\n\\int_0^1 x dx\n$$", {});

    expect(tokens).toHaveLength(1);
    expect(tokens[0]?.type).toBe("math_block");
    expect(tokens[0]?.content.trim()).toBe("\\int_0^1 x dx");
  });

  it("parses streaming unclosed math block without throwing", () => {
    const md = createParser();
    const tokens = md.parse("$$\n\\int_0^1 x dx", {});

    expect(tokens).toHaveLength(1);
    expect(tokens[0]?.type).toBe("math_block");
    expect(tokens[0]?.content.trim()).toBe("\\int_0^1 x dx");
  });

  it("renders math to HTML via default rules", () => {
    const md = createParser();
    const rendered = md.render("formula $x^2$");

    expect(rendered).toContain('class="katex"');
  });
});
