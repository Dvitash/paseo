import { describe, expect, it } from "vitest";
import { formatLatexToReadableText } from "./latex-to-text";

describe("formatLatexToReadableText", () => {
  it("formats single variable", () => {
    expect(formatLatexToReadableText("w")).toBe("w");
  });

  it("formats degrees and text", () => {
    expect(formatLatexToReadableText("14.34^\\circ/\\text{stud}")).toBe("14.34°/stud");
  });

  it("formats Greek letters and operations", () => {
    expect(formatLatexToReadableText("360 / (2\\pi \\cdot 4)")).toBe("360/( 2 π ⋅ 4 )");
  });

  it("formats superscripts", () => {
    expect(formatLatexToReadableText("x^2 + y^2 = z^2")).toBe("x² + y² = z²");
  });

  it("formats subscripts", () => {
    expect(formatLatexToReadableText("x_0 + x_1")).toBe("x₀ + x₁");
  });

  it("formats fractions", () => {
    expect(formatLatexToReadableText("\\frac{a}{b}")).toBe("a/b");
  });

  it("handles empty input", () => {
    expect(formatLatexToReadableText("")).toBe("");
  });
});
