import type MarkdownIt from "markdown-it";
import { renderToString } from "katex";

type RuleInline = Parameters<MarkdownIt["inline"]["ruler"]["after"]>[2];
type StateInline = Parameters<RuleInline>[0];

type RuleBlock = Parameters<MarkdownIt["block"]["ruler"]["after"]>[2];
type StateBlock = Parameters<RuleBlock>[0];

function isValidDelim(state: StateInline, pos: number): { can_open: boolean; can_close: boolean } {
  const max = state.posMax;
  let can_open = true;
  let can_close = true;

  const prevChar = pos > 0 ? state.src.charCodeAt(pos - 1) : -1;
  const nextChar = pos + 1 <= max ? state.src.charCodeAt(pos + 1) : -1;

  // Check non-whitespace conditions for opening and closing, and
  // check that closing delimiter is not preceded by whitespace or followed by a digit.
  if (
    prevChar === 0x20 /* space */ ||
    prevChar === 0x09 /* tab */ ||
    (nextChar >= 0x30 /* '0' */ && nextChar <= 0x39) /* '9' */
  ) {
    can_close = false;
  }
  if (nextChar === 0x20 /* space */ || nextChar === 0x09 /* tab */) {
    can_open = false;
  }

  return { can_open, can_close };
}

function mathInlineRule(state: StateInline, silent: boolean): boolean {
  if (state.src.charCodeAt(state.pos) !== 0x24 /* '$' */) {
    return false;
  }

  const res = isValidDelim(state, state.pos);
  if (!res.can_open) {
    if (!silent) {
      state.pending += "$";
    }
    state.pos += 1;
    return true;
  }

  const start = state.pos + 1;
  let match = start;

  while ((match = state.src.indexOf("$", match)) !== -1) {
    let pos = match - 1;
    while (state.src.charCodeAt(pos) === 0x5c /* '\\' */) {
      pos -= 1;
    }

    if ((match - pos) % 2 === 1) {
      break;
    }
    match += 1;
  }

  if (match === -1) {
    if (!silent) {
      state.pending += "$";
    }
    state.pos = start;
    return true;
  }

  // Inline math cannot span across newlines
  const newlinePos = state.src.indexOf("\n", start);
  if (newlinePos !== -1 && newlinePos < match) {
    if (!silent) {
      state.pending += "$";
    }
    state.pos = start;
    return true;
  }

  // Empty content ($$) is not inline math
  if (match - start === 0) {
    if (!silent) {
      state.pending += "$$";
    }
    state.pos = start + 1;
    return true;
  }

  const closeRes = isValidDelim(state, match);
  if (!closeRes.can_close) {
    if (!silent) {
      state.pending += "$";
    }
    state.pos = start;
    return true;
  }

  if (!silent) {
    const token = state.push("math_inline", "math", 0);
    token.markup = "$";
    token.content = state.src.slice(start, match);
  }

  state.pos = match + 1;
  return true;
}

function mathBlockRule(state: StateBlock, start: number, end: number, silent: boolean): boolean {
  let pos = state.bMarks[start] + state.tShift[start];
  const max = state.eMarks[start];

  if (pos + 2 > max) {
    return false;
  }
  if (state.src.slice(pos, pos + 2) !== "$$") {
    return false;
  }

  pos += 2;
  let firstLine = state.src.slice(pos, max);

  if (silent) {
    return true;
  }

  let found = false;
  let lastLine = "";
  if (firstLine.trim().slice(-2) === "$$") {
    // Single-line expression
    firstLine = firstLine.trim().slice(0, -2);
    found = true;
  }

  let next = start;
  while (!found) {
    next += 1;

    if (next >= end) {
      break;
    }

    pos = state.bMarks[next] + state.tShift[next];
    const lineMax = state.eMarks[next];

    if (pos < lineMax && state.tShift[next] < state.blkIndent) {
      // Non-empty line with negative indent stops
      break;
    }

    if (state.src.slice(pos, lineMax).trim().slice(-2) === "$$") {
      const lastPos = state.src.slice(0, lineMax).lastIndexOf("$$");
      lastLine = state.src.slice(pos, lastPos);
      found = true;
    }
  }

  state.line = next + 1;

  const token = state.push("math_block", "math", 0);
  token.block = true;
  token.content =
    (firstLine && firstLine.trim() ? `${firstLine}\n` : "") +
    state.getLines(start + 1, next, state.tShift[start], true) +
    (lastLine && lastLine.trim() ? lastLine : "");
  token.map = [start, state.line];
  token.markup = "$$";
  return true;
}

export function markdownMathPlugin(md: MarkdownIt): void {
  md.inline.ruler.after("escape", "math_inline", mathInlineRule);
  md.block.ruler.after("blockquote", "math_block", mathBlockRule, {
    alt: ["paragraph", "reference", "blockquote", "list"],
  });

  // Default HTML rendering rules if markdown-it.render is called directly
  md.renderer.rules.math_inline = (tokens, idx) => {
    const content = tokens[idx]?.content ?? "";
    try {
      return renderToString(content, { displayMode: false, throwOnError: false });
    } catch {
      return content;
    }
  };

  md.renderer.rules.math_block = (tokens, idx) => {
    const content = tokens[idx]?.content ?? "";
    try {
      return `<div class="katex-block">${renderToString(content, {
        displayMode: true,
        throwOnError: false,
      })}</div>\n`;
    } catch {
      return `<pre class="katex-block">${content}</pre>\n`;
    }
  };
}
