import React, { useMemo, type CSSProperties } from "react";
import { renderToString } from "katex";
import type { MathProps } from "./types";

const INLINE_MATH_STYLE: CSSProperties = {
  display: "inline-block",
  verticalAlign: "baseline",
};

const BLOCK_MATH_STYLE: CSSProperties = {
  display: "block",
  textAlign: "center",
  margin: "0.5em 0",
  overflowX: "auto",
  overflowY: "hidden",
  maxWidth: "100%",
};

export function MathInline({ latex }: MathProps) {
  const innerHtml = useMemo(() => {
    try {
      return {
        __html: renderToString(latex, {
          displayMode: false,
          throwOnError: false,
        }),
      };
    } catch {
      return { __html: latex };
    }
  }, [latex]);

  return (
    <span
      data-paseo-markdown-tag="math-inline"
      data-paseo-math-latex={latex}
      dangerouslySetInnerHTML={innerHtml}
      style={INLINE_MATH_STYLE}
    />
  );
}

export function MathBlock({ latex }: MathProps) {
  const innerHtml = useMemo(() => {
    try {
      return {
        __html: renderToString(latex, {
          displayMode: true,
          throwOnError: false,
        }),
      };
    } catch {
      return { __html: latex };
    }
  }, [latex]);

  return (
    <div
      data-paseo-markdown-tag="math-block"
      data-paseo-math-latex={latex}
      dangerouslySetInnerHTML={innerHtml}
      style={BLOCK_MATH_STYLE}
    />
  );
}
