import { Suspense, lazy, useMemo } from "react";
import { View, type ViewStyle } from "react-native";
import { HighlightedCodeBlock } from "@/components/highlighted-code-block";
import type { MarkdownFenceRendererProps } from "../types";

const LazyMermaidHost = lazy(() =>
  import("./host").then((module) => ({ default: module.MermaidFenceHost })),
);

const sourceContainerStyle: ViewStyle = { position: "relative" };

function MermaidLazyFallback({ code, inheritedStyles, textStyle }: MarkdownFenceRendererProps) {
  return (
    <View style={sourceContainerStyle}>
      <HighlightedCodeBlock
        code={code}
        language="mermaid"
        inheritedStyles={inheritedStyles}
        textStyle={textStyle}
      />
    </View>
  );
}

export function MermaidFence(props: MarkdownFenceRendererProps) {
  const { code, phase, inheritedStyles, textStyle } = props;
  const fallback = useMemo(
    () => (
      <MermaidLazyFallback
        code={code}
        phase={phase}
        inheritedStyles={inheritedStyles}
        textStyle={textStyle}
      />
    ),
    [code, phase, inheritedStyles, textStyle],
  );
  return (
    <Suspense fallback={fallback}>
      <LazyMermaidHost {...props} />
    </Suspense>
  );
}
