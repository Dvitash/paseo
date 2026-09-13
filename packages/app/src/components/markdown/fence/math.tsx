import React from "react";
import { MathBlock } from "@/components/markdown/math";
import type { MarkdownFenceRendererProps } from "./types";

export function MathFence({ code }: MarkdownFenceRendererProps) {
  return <MathBlock latex={code} />;
}
