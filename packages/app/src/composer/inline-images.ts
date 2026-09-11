import type { AttachmentMetadata, ComposerAttachment } from "@/attachments/types";
import type { ImageAttachment } from "@/composer/types";

/**
 * Inline image tokens.
 *
 * Pasted images are anchored in the draft text as `[image:slug#CODE]` tokens
 * where CODE derives from the attachment id and slug is a readable filename
 * hint (the slug is display-only; resolution always uses the code). On web the
 * composer overlays a pill on each token (see `inline-image-overlay.web.tsx`);
 * on native the token renders as a styled text span. The editor keeps the raw
 * token so caret math, drafts, and queued messages stay plain text.
 *
 * Paste inserts a provisional token (`pending` code) synchronously so the
 * caret position is captured at paste time; it is swapped for the real token
 * once the attachment persists.
 *
 * At wire time `buildComposerWirePayload` rewrites every resolvable token to
 * `[image:N]`, where N is the 1-based index into the wire `images` array, so
 * the model can tell which image sits where in the prompt. Draft and queue
 * state keep the stable ID tokens so failure-restore and queued-message edit
 * never lose identity.
 */

export interface InlineImageToken {
  start: number;
  end: number;
  /** Resolution code: attachment-id-derived, `pending…`, or positional digits. */
  code: string;
  /** Readable filename slug before `#`, when present. */
  label: string | null;
}
// Body cap covers the generated maximum: slug (40) + "#" + code (8 or pending12).
const INLINE_IMAGE_TOKEN_PATTERN = /\[image:([a-z0-9._#-]{1,64})\]/gi;
const POSITIONAL_CODE_PATTERN = /^\d{1,3}$/;
const PROVISIONAL_CODE_PATTERN = /^pending\d+x$/;
const SLUG_CODE_SEPARATOR = "#";

let provisionalCounter = 0;

export function findInlineImageTokens(text: string): InlineImageToken[] {
  const tokens: InlineImageToken[] = [];
  for (const match of text.matchAll(INLINE_IMAGE_TOKEN_PATTERN)) {
    const start = match.index ?? 0;
    const body = match[1];
    const separator = body.lastIndexOf(SLUG_CODE_SEPARATOR);
    const code = (separator >= 0 ? body.slice(separator + 1) : body).toLowerCase();
    const label = separator > 0 ? body.slice(0, separator) : null;
    if (!code) continue;
    tokens.push({ start, end: start + match[0].length, code, label });
  }
  return tokens;
}

/** Short alphanumeric code embedded in a token; derived from the attachment id. */
export function inlineImageTokenCode(attachmentId: string): string {
  const normalized = attachmentId.toLowerCase().replace(/[^a-z0-9]/g, "");
  return normalized.slice(-8) || normalized || "x";
}

function inlineImageSlug(fileName: string | null | undefined): string {
  if (!fileName) return "";
  return fileName
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

export function buildInlineImageToken(attachmentId: string, fileName?: string | null): string {
  const slug = inlineImageSlug(fileName);
  const code = inlineImageTokenCode(attachmentId);
  return slug ? `[image:${slug}#${code}]` : `[image:${code}]`;
}

function buildProvisionalInlineImageToken(code: string, fileName?: string | null): string {
  const slug = inlineImageSlug(fileName);
  return slug ? `[image:${slug}#${code}]` : `[image:${code}]`;
}

/** Provisional codes are longer than the 8-char id-derived codes, so they never collide. */
export function nextProvisionalInlineImageCode(): string {
  provisionalCounter += 1;
  return `pending${provisionalCounter}x`;
}

export function isProvisionalInlineImageCode(code: string): boolean {
  return PROVISIONAL_CODE_PATTERN.test(code);
}

function imageAttachmentsOnly(
  attachments: readonly ComposerAttachment[],
): Extract<ComposerAttachment, { kind: "image" }>[] {
  return attachments.filter(
    (attachment): attachment is Extract<ComposerAttachment, { kind: "image" }> =>
      attachment.kind === "image",
  );
}

/**
 * Resolve a token to an image attachment: first by id-derived code, then —
 * for pure-digit codes — positionally among image attachments.
 */
export function resolveInlineImageToken(
  token: InlineImageToken,
  attachments: readonly ComposerAttachment[],
): Extract<ComposerAttachment, { kind: "image" }> | null {
  const images = imageAttachmentsOnly(attachments);
  const byCode = images.find(
    (attachment) => inlineImageTokenCode(attachment.metadata.id) === token.code,
  );
  if (byCode) return byCode;
  if (POSITIONAL_CODE_PATTERN.test(token.code)) {
    const position = Number.parseInt(token.code, 10);
    if (position >= 1 && position <= images.length) {
      return images[position - 1];
    }
  }
  return null;
}

/** True when the text contains a token that resolves to this image attachment. */
export function isImageAttachmentAnchored(
  text: string,
  attachment: Extract<ComposerAttachment, { kind: "image" }>,
  attachments: readonly ComposerAttachment[],
): boolean {
  for (const token of findInlineImageTokens(text)) {
    if (resolveInlineImageToken(token, attachments) === attachment) return true;
  }
  return false;
}

/**
 * Rewrite resolvable tokens to `[image:N]` where N is the 1-based index into
 * `wireImages` (the images array produced by `splitComposerAttachmentsForSubmit`,
 * in order). Tokens that resolve to nothing are left untouched so user-typed
 * lookalikes survive. NOT idempotent: run exactly once per wire payload.
 */
export function resolveInlineImageReferences(
  text: string,
  wireImages: readonly AttachmentMetadata[],
  attachments: readonly ComposerAttachment[],
): string {
  const tokens = findInlineImageTokens(text);
  if (tokens.length === 0) return text;
  const wireIndexById = new Map<string, number>();
  wireImages.forEach((metadata, index) => {
    if (!wireIndexById.has(metadata.id)) wireIndexById.set(metadata.id, index + 1);
  });
  let next = text;
  for (let i = tokens.length - 1; i >= 0; i -= 1) {
    const token = tokens[i];
    const attachment = resolveInlineImageToken(token, attachments);
    if (!attachment) continue;
    const wireIndex = wireIndexById.get(attachment.metadata.id);
    if (wireIndex === undefined) continue;
    next = `${next.slice(0, token.start)}[image:${wireIndex}]${next.slice(token.end)}`;
  }
  return next;
}

/**
 * Remove every token that resolves to the given attachment. Returns the new
 * text plus the caret position adjusted for removed ranges.
 */
export function stripInlineImageTokens(input: {
  text: string;
  attachment: ComposerAttachment;
  attachments: readonly ComposerAttachment[];
  caret: number;
}): { text: string; caret: number } {
  const tokens = findInlineImageTokens(input.text);
  let next = input.text;
  let caret = input.caret;
  for (let i = tokens.length - 1; i >= 0; i -= 1) {
    const token = tokens[i];
    if (resolveInlineImageToken(token, input.attachments) !== input.attachment) continue;
    next = `${next.slice(0, token.start)}${next.slice(token.end)}`;
    if (caret >= token.end) {
      caret -= token.end - token.start;
    } else if (caret > token.start) {
      caret = token.start;
    }
  }
  return { text: next, caret };
}

export interface InlineImageDeletion {
  start: number;
  end: number;
}

/**
 * Insert one token per item at the caret. Items with `metadata` get a resolved
 * token immediately (picker/menu paste); items without get a provisional
 * `pending…` token to settle later. Returns the new text, the caret after the
 * inserted tokens, all codes in item order, and the provisional subset.
 */
export function insertInlineImageTokensIntoText(input: {
  text: string;
  start: number;
  end: number;
  items: readonly { fileName?: string | null; metadata?: ImageAttachment | null }[];
}): { text: string; caret: number; codes: string[]; provisionalCodes: string[] } {
  const codes: string[] = [];
  const provisionalCodes: string[] = [];
  const tokens = input.items
    .map((item) => {
      if (item.metadata) {
        const code = inlineImageTokenCode(item.metadata.id);
        codes.push(code);
        return buildInlineImageToken(item.metadata.id, item.metadata.fileName);
      }
      const code = nextProvisionalInlineImageCode();
      codes.push(code);
      provisionalCodes.push(code);
      return buildProvisionalInlineImageToken(code, item.fileName);
    })
    .join("");
  const start = Math.min(input.start, input.text.length);
  const end = Math.min(Math.max(input.end, start), input.text.length);
  const text = `${input.text.slice(0, start)}${tokens}${input.text.slice(end)}`;
  return { text, caret: start + tokens.length, codes, provisionalCodes };
}

/**
 * Expand a pending Backspace/Delete so it swallows whole tokens instead of
 * leaving half-edited `[image:…` fragments. Collapsed caret: Backspace removes
 * the token ending at the caret, Delete removes the token starting at it, and
 * a caret strictly inside a token deletes the whole token either way.
 * Non-collapsed selections grow to cover any token they partially overlap.
 * Returns null when no token is involved and the default edit should run.
 */
export function expandInlineImageDeletion(input: {
  text: string;
  start: number;
  end: number;
  direction: "backward" | "forward";
}): InlineImageDeletion | null {
  const tokens = findInlineImageTokens(input.text);
  if (tokens.length === 0) return null;
  const { start, end } = input;

  if (start === end) {
    for (const token of tokens) {
      const inside = token.start < start && token.end > start;
      if (input.direction === "backward" && (token.end === start || inside)) {
        return { start: token.start, end: token.end };
      }
      if (input.direction === "forward" && (token.start === start || inside)) {
        return { start: token.start, end: token.end };
      }
    }
    return null;
  }

  let nextStart = start;
  let nextEnd = end;
  for (const token of tokens) {
    const overlaps = token.start < nextEnd && token.end > nextStart;
    const fullyInside = token.start >= nextStart && token.end <= nextEnd;
    if (overlaps && !fullyInside) {
      nextStart = Math.min(nextStart, token.start);
      nextEnd = Math.max(nextEnd, token.end);
    }
  }
  if (nextStart === start && nextEnd === end) return null;
  return { start: nextStart, end: nextEnd };
}

/**
 * Snap a collapsed caret out of a token to its nearest boundary so typing
 * can't split a token into dead text. Returns the caret unchanged when it is
 * not strictly inside a token.
 */
export function snapInlineImageCaret(text: string, caret: number): number {
  for (const token of findInlineImageTokens(text)) {
    if (token.start < caret && token.end > caret) {
      return caret - token.start <= token.end - caret ? token.start : token.end;
    }
  }
  return caret;
}

/**
 * Insert one provisional token per pasted file at the caret. Returns the new
 * text, the caret position after the inserted tokens, and the provisional
 * codes in file order. Callers apply the result via `replaceText` and settle
 * each code with `resolveProvisionalInlineImageToken` /
 * `discardProvisionalInlineImageToken` once persistence completes.
 */
export function insertProvisionalInlineImageTokens(input: {
  text: string;
  start: number;
  end: number;
  fileNames: readonly (string | null | undefined)[];
}): { text: string; caret: number; codes: string[] } {
  const codes = input.fileNames.map(() => nextProvisionalInlineImageCode());
  const tokens = input.fileNames
    .map((fileName, index) => buildProvisionalInlineImageToken(codes[index], fileName))
    .join("");
  const start = Math.min(input.start, input.text.length);
  const end = Math.min(Math.max(input.end, start), input.text.length);
  const text = `${input.text.slice(0, start)}${tokens}${input.text.slice(end)}`;
  return { text, caret: start + tokens.length, codes };
}

/**
 * Swap a provisional token for the real attachment token. Returns null when
 * the provisional token is gone (user deleted it while the paste was in
 * flight) — the caller should drop that image instead of attaching it.
 */
export function resolveProvisionalInlineImageToken(input: {
  text: string;
  code: string;
  attachment: AttachmentMetadata;
  caret: number;
}): { text: string; caret: number } | null {
  const token = findInlineImageTokens(input.text).find(
    (candidate) => candidate.code === input.code,
  );
  if (!token) return null;
  const replacement = buildInlineImageToken(input.attachment.id, input.attachment.fileName);
  const text = `${input.text.slice(0, token.start)}${replacement}${input.text.slice(token.end)}`;
  let caret = input.caret;
  const delta = replacement.length - (token.end - token.start);
  if (caret >= token.end) {
    caret += delta;
  } else if (caret > token.start) {
    caret = token.start + replacement.length;
  }
  return { text, caret };
}

/** Remove a provisional token whose paste failed. Null when already gone. */
export function discardProvisionalInlineImageToken(input: {
  text: string;
  code: string;
  caret: number;
}): { text: string; caret: number } | null {
  const token = findInlineImageTokens(input.text).find(
    (candidate) => candidate.code === input.code,
  );
  if (!token) return null;
  const text = `${input.text.slice(0, token.start)}${input.text.slice(token.end)}`;
  let caret = input.caret;
  if (caret >= token.end) {
    caret -= token.end - token.start;
  } else if (caret > token.start) {
    caret = token.start;
  }
  return { text, caret };
}

export interface InlineImageTextEdit {
  /** Corrected text (damaged token remnants removed). */
  text: string;
  caret: number;
  /** Codes of tokens that were deleted or damaged by this edit. */
  removedCodes: string[];
}

/**
 * Reconcile an already-applied text edit against the previous token set.
 * Any token that was deleted outright or left damaged is reported in
 * `removedCodes` (so the attachment can be removed) and its remnant is
 * stripped from the corrected text.
 */
export function resolveInlineImageTextEdit(input: {
  previousText: string;
  nextText: string;
  caret: number;
}): InlineImageTextEdit | null {
  const { previousText, nextText } = input;
  if (previousText === nextText) return null;
  const tokens = findInlineImageTokens(previousText);
  if (tokens.length === 0) return null;

  // Common prefix/suffix give the replaced range in both texts.
  let prefix = 0;
  const maxPrefix = Math.min(previousText.length, nextText.length);
  while (prefix < maxPrefix && previousText[prefix] === nextText[prefix]) {
    prefix += 1;
  }
  let suffix = 0;
  const maxSuffix = Math.min(previousText.length - prefix, nextText.length - prefix);
  while (
    suffix < maxSuffix &&
    previousText[previousText.length - 1 - suffix] === nextText[nextText.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  const deletedStart = prefix;
  const deletedEnd = previousText.length - suffix;
  const insertedText = nextText.slice(prefix, nextText.length - suffix);

  // Expand the replaced range (in previousText coordinates) to cover every
  // token it touches, so tokens are removed atomically while the user's
  // inserted text is preserved.
  let expandedStart = deletedStart;
  let expandedEnd = deletedEnd;
  const removedCodes: string[] = [];
  for (const token of tokens) {
    const overlaps = token.start < expandedEnd && token.end > expandedStart;
    if (!overlaps) continue;
    removedCodes.push(token.code);
    expandedStart = Math.min(expandedStart, token.start);
    expandedEnd = Math.max(expandedEnd, token.end);
  }
  if (removedCodes.length === 0) return null;

  const text =
    previousText.slice(0, expandedStart) + insertedText + previousText.slice(expandedEnd);
  const caret = expandedStart + insertedText.length;
  return { text, caret, removedCodes };
}

/** Minimal external store carrying the live (unpublished) editor text. */
export interface InlineImageTextStore {
  get(): string;
  set(text: string): void;
  subscribe(listener: () => void): () => void;
}

export function createInlineImageTextStore(initial: string): InlineImageTextStore {
  let current = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => current,
    set: (text) => {
      if (text === current) return;
      current = text;
      for (const listener of listeners) listener();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
