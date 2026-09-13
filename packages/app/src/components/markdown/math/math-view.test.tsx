/**
 * @vitest-environment jsdom
 */
import * as React from "react";
import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MathBlock, MathInline } from "./index";

vi.stubGlobal("React", React);

describe("Math components", () => {
  it("renders inline math with KaTeX markup on web", () => {
    const { container } = render(<MathInline latex="w" />);
    const span = container.querySelector('[data-paseo-markdown-tag="math-inline"]');

    expect(span).toBeTruthy();
    expect(span?.getAttribute("data-paseo-math-latex")).toBe("w");
    expect(span?.innerHTML).toContain("katex");
  });

  it("renders complex inline math formula", () => {
    const { container } = render(<MathInline latex="14.34^\circ/\text{stud}" />);
    const span = container.querySelector('[data-paseo-markdown-tag="math-inline"]');

    expect(span).toBeTruthy();
    expect(span?.getAttribute("data-paseo-math-latex")).toBe("14.34^\\circ/\\text{stud}");
    expect(span?.innerHTML).toContain("katex");
  });

  it("renders block math with centered container", () => {
    const { container } = render(<MathBlock latex="\int_0^1 x dx" />);
    const block = container.querySelector('[data-paseo-markdown-tag="math-block"]');

    expect(block).toBeTruthy();
    expect(block?.getAttribute("data-paseo-math-latex")).toBe("\\int_0^1 x dx");
    expect(block?.innerHTML).toContain("katex");
  });
});
