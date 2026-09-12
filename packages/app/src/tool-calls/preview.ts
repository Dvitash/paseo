export interface BoundedToolText {
  text: string;
  truncated: boolean;
}

export function boundToolText(text: string, maxLines: number, maxChars: number): BoundedToolText {
  if (text.length === 0) {
    return { text: "", truncated: false };
  }

  if (maxLines <= 0 || maxChars <= 0) {
    return { text: "", truncated: true };
  }

  let lineCount = 1;
  let lineCutIndex = text.length;

  const scanLimit = Math.min(text.length, maxChars + 1);
  for (let i = 0; i < scanLimit; i++) {
    if (text[i] === "\n") {
      if (lineCount >= maxLines) {
        lineCutIndex = i > 0 && text[i - 1] === "\r" ? i - 1 : i;
        break;
      }
      lineCount++;
    }
  }

  const charCutIndex = Math.min(text.length, maxChars);
  let effectiveCutIndex = Math.min(lineCutIndex, charCutIndex);

  if (effectiveCutIndex > 0 && effectiveCutIndex < text.length) {
    const prevCode = text.charCodeAt(effectiveCutIndex - 1);
    const nextCode = text.charCodeAt(effectiveCutIndex);
    const isSurrogatePair =
      prevCode >= 0xd800 && prevCode <= 0xdbff && nextCode >= 0xdc00 && nextCode <= 0xdfff;

    if (isSurrogatePair) {
      effectiveCutIndex--;
    }
  }

  const truncated = effectiveCutIndex < text.length;
  const boundedText = truncated ? text.slice(0, effectiveCutIndex) : text;

  return {
    text: boundedText,
    truncated,
  };
}
