import { z } from "zod";

export interface EvalNormalizedError {
  message: string;
  details: string;
}

const PreNormalizedSchema = z.object({
  message: z.string(),
  details: z.string(),
});

const ContentEnvelopeSchema = z.object({
  content: z.array(z.unknown()),
  isError: z.boolean().optional(),
});

const OkFalseEnvelopeSchema = z.object({
  ok: z.literal(false),
  error: z.unknown().optional(),
  output: z.array(z.unknown()).optional(),
});

const GenericErrorObjectSchema = z.object({
  message: z.string().optional(),
  error: z.unknown().optional(),
  isError: z.boolean().optional(),
  stack: z.string().optional(),
});

const TextBlockSchema = z.object({
  type: z.literal("text"),
  text: z.string(),
});

function isTextBlock(value: unknown): value is { type: "text"; text: string } {
  return TextBlockSchema.safeParse(value).success;
}

function appendStdoutToDetails(details: string, stdout?: string): string {
  if (!stdout) {
    return details;
  }
  const trimmedStdout = stdout.trim();
  if (trimmedStdout.length === 0 || details.includes(trimmedStdout)) {
    return details;
  }
  return `${stdout}\n${details}`;
}

const EMPTY_ERROR_MESSAGES: Record<string, true> = {
  "": true,
  true: true,
  false: true,
  "[object Object]": true,
};

export function extractActionableErrorMessage(str: string, depth = 0): string {
  if (typeof str !== "string" || depth > 6) {
    return "";
  }
  const trimmed = str.trim();
  if (Object.hasOwn(EMPTY_ERROR_MESSAGES, trimmed)) {
    return "";
  }

  if (trimmed.includes('"error":')) {
    const match = trimmed.match(/"error"\s*:\s*"((?:\\.|[^"\\])*)"/);
    if (match) {
      try {
        const unescaped: unknown = JSON.parse(`"${match[1]}"`);
        const extracted =
          typeof unescaped === "string" ? extractActionableErrorMessage(unescaped, depth + 1) : "";
        if (extracted) {
          return extracted;
        }
      } catch {}
    }
  }

  const lines = trimmed
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) {
    return "";
  }

  if (lines[0].startsWith("Traceback (most recent call last):")) {
    return extractActionableErrorMessage(lines[lines.length - 1], depth + 1);
  }

  let line = lines[0];
  const errorNameMatch = line.match(/^([A-Z][a-zA-Z0-9_]*Error):\s*(.*)$/);
  if (errorNameMatch) {
    const [, name, rest] = errorNameMatch;
    if (name === "Error") {
      line = rest || name;
    } else {
      const cleanRest = rest.replace(/^(?:[a-zA-Z0-9_<>()\s.-]+:\d+(?::\d+)?:\s*)+/, "").trim();
      return cleanRest ? `${name}: ${cleanRest}` : line;
    }
  } else if (/^Error:\s*/i.test(line)) {
    line = line.replace(/^Error:\s*/i, "");
  }

  line = line.replace(/^(?:[a-zA-Z0-9_<>()\s.-]+:\d+(?::\d+)?:\s*)+/, "").trim();
  if (line.startsWith("{") || line.startsWith("[")) {
    return "";
  }

  return line || lines[0];
}

export function isScreenshotErrorEnvelope(str: string): boolean {
  if (typeof str !== "string") {
    return false;
  }
  return /^(?:Error:\s*)?\{[\s\S]*"ok"\s*:\s*false/.test(str.trim());
}

export function sanitizeOutputText(output: unknown): string {
  return typeof output === "string" ? output : "";
}

function normalizeBooleanError(contextOutput: unknown, depth: number): EvalNormalizedError {
  if (typeof contextOutput === "string") {
    const trimmed = contextOutput.trim();
    if (trimmed.length > 0) {
      const nested = normalizeEvalError(contextOutput, undefined, depth + 1);
      if (nested) {
        return nested;
      }
      const msg = extractActionableErrorMessage(contextOutput);
      return {
        message: msg || "Evaluation failed",
        details: contextOutput,
      };
    }
  }
  if (typeof contextOutput === "object" && contextOutput !== null) {
    const nested = normalizeEvalError(contextOutput, undefined, depth + 1);
    if (nested) {
      return nested;
    }
  }
  return { message: "Evaluation failed", details: "Evaluation failed" };
}

function normalizePreNormalized(record: unknown): EvalNormalizedError | null {
  const parsed = PreNormalizedSchema.safeParse(record);
  if (!parsed.success) {
    return null;
  }
  return {
    message: extractActionableErrorMessage(parsed.data.message) || "Evaluation failed",
    details: parsed.data.details,
  };
}

function normalizeContentEnvelope(record: unknown, depth: number): EvalNormalizedError | null {
  const parsed = ContentEnvelopeSchema.safeParse(record);
  if (!parsed.success) {
    return null;
  }
  const texts = parsed.data.content.filter(isTextBlock).map((b) => b.text);
  if (texts.length === 0) {
    return null;
  }

  const combined = texts.join("\n");
  const nested = normalizeEvalError(combined, undefined, depth + 1);
  if (nested) {
    return nested;
  }

  if (parsed.data.isError === true) {
    const msg = extractActionableErrorMessage(combined);
    return { message: msg || "Evaluation failed", details: combined };
  }
  return null;
}

function normalizeOkFalseEnvelope(record: unknown, depth: number): EvalNormalizedError | null {
  const parsed = OkFalseEnvelopeSchema.safeParse(record);
  if (!parsed.success || parsed.data.error === undefined || parsed.data.error === null) {
    return null;
  }
  const inner = normalizeEvalError(parsed.data.error, undefined, depth + 1);
  if (!inner) {
    return null;
  }

  const stdout = parsed.data.output?.filter((v): v is string => typeof v === "string").join("");
  return {
    message: inner.message,
    details: appendStdoutToDetails(inner.details, stdout),
  };
}

function normalizeGenericErrorObject(
  record: unknown,
  contextOutput: unknown,
  depth: number,
): EvalNormalizedError | null {
  const parsed = GenericErrorObjectSchema.safeParse(record);
  if (!parsed.success) {
    return null;
  }

  if (
    parsed.data.error !== undefined &&
    parsed.data.error !== null &&
    parsed.data.error !== false
  ) {
    return normalizeEvalError(parsed.data.error, contextOutput, depth + 1);
  }

  if (parsed.data.message && parsed.data.message.trim().length > 0) {
    const inner = normalizeEvalError(parsed.data.message, undefined, depth + 1);
    if (inner) {
      const details =
        parsed.data.stack && !inner.details.includes(parsed.data.stack)
          ? `${inner.details}\n${parsed.data.stack}`
          : inner.details;
      return { message: inner.message, details };
    }
    return {
      message: extractActionableErrorMessage(parsed.data.message) || "Evaluation failed",
      details: parsed.data.stack || parsed.data.message,
    };
  }

  if (parsed.data.isError === true) {
    return normalizeBooleanError(contextOutput, depth);
  }

  return null;
}

function normalizeErrorObject(
  record: unknown,
  contextOutput: unknown,
  depth: number,
): EvalNormalizedError | null {
  return (
    normalizePreNormalized(record) ||
    normalizeContentEnvelope(record, depth) ||
    normalizeOkFalseEnvelope(record, depth) ||
    normalizeGenericErrorObject(record, contextOutput, depth)
  );
}

function normalizeComplexJsonErrorString(str: string, depth: number): EvalNormalizedError | null {
  const match = str.match(/^(?:Error:\s*)?(\{[\s\S]*?\})(?:\r?\n([\s\S]*))?$/);
  if (!match) {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(match[1]);
    const inner = normalizeEvalError(parsed, undefined, depth + 1);
    if (!inner) {
      return null;
    }

    const stackRest = match[2]?.replace(/^\r?\n/, "").trimEnd();
    const details =
      stackRest && !inner.details.includes(stackRest)
        ? `${inner.details}\n${stackRest}`
        : inner.details;
    return { message: inner.message, details };
  } catch {
    return null;
  }
}

function normalizeJsonEncodedString(
  str: string,
  contextOutput: unknown,
  depth: number,
): EvalNormalizedError | null {
  if (!str.startsWith("{") && !str.startsWith("[")) {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(str);
    return normalizeEvalError(parsed, contextOutput, depth + 1);
  } catch {
    return null;
  }
}

function normalizeErrorString(
  str: string,
  contextOutput: unknown,
  depth: number,
): EvalNormalizedError | null {
  const trimmed = str.trim();
  if (!trimmed) {
    return null;
  }

  const complex = normalizeComplexJsonErrorString(trimmed, depth);
  if (complex) {
    return complex;
  }

  const json = normalizeJsonEncodedString(trimmed, contextOutput, depth);
  if (json) {
    return json;
  }

  const message = extractActionableErrorMessage(trimmed);
  return {
    message: message || "Evaluation failed",
    details: str,
  };
}

export function normalizeEvalError(
  errorInput: unknown,
  contextOutput?: unknown,
  depth = 0,
): EvalNormalizedError | null {
  if (depth > 6 || errorInput === null || errorInput === undefined || errorInput === false) {
    return null;
  }

  if (errorInput === true) {
    return normalizeBooleanError(contextOutput, depth);
  }

  if (errorInput instanceof Error) {
    const rawDetails = errorInput.stack || errorInput.message || errorInput.name;
    const message =
      extractActionableErrorMessage(errorInput.message || errorInput.name) || "Evaluation failed";
    return { message, details: rawDetails };
  }

  if (typeof errorInput === "string") {
    return normalizeErrorString(errorInput, contextOutput, depth);
  }

  if (typeof errorInput === "object") {
    return normalizeErrorObject(errorInput, contextOutput, depth);
  }

  return null;
}
