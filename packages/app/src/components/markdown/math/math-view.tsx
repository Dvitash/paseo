import React, { useMemo } from "react";
import { StyleSheet, Text, View, type TextStyle, type ViewStyle } from "react-native";
import { MarkdownTextSpan } from "@/components/markdown-text";
import { formatLatexToReadableText } from "@/utils/latex-to-text";
import type { MathProps } from "./types";

export function MathInline({ latex, style }: MathProps) {
  const text = useMemo(() => formatLatexToReadableText(latex), [latex]);

  return <MarkdownTextSpan style={[styles.inline, style as TextStyle]}>{text}</MarkdownTextSpan>;
}

export function MathBlock({ latex, style }: MathProps) {
  const text = useMemo(() => formatLatexToReadableText(latex), [latex]);

  return (
    <View style={[styles.blockContainer, style as ViewStyle]}>
      <Text style={styles.blockText}>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  inline: {
    fontStyle: "italic",
  },
  blockContainer: {
    alignItems: "center",
    justifyContent: "center",
    marginVertical: 8,
    width: "100%",
  },
  blockText: {
    fontSize: 16,
    fontStyle: "italic",
    textAlign: "center",
  },
});
