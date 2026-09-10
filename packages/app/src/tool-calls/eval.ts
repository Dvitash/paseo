import { z } from "zod";
import type { ToolCallDetail } from "@getpaseo/protocol/agent-types";
import { normalizeToolName } from "@getpaseo/protocol/tool-name-normalization";
import { type EvalNormalizedError, normalizeEvalError } from "./eval-error";

export type { EvalNormalizedError };

export interface EvalCell {
  id: string;
  title: string | null;
  language: string | null;
  code: string;
  output: string;
  error?: EvalNormalizedError;
}

export interface EvalPresentation {
  title: string | null;
  cells: EvalCell[];
  error?: EvalNormalizedError;
}

interface NormalizedInput {
  code: string;
  language: string | null;
  title: string | null;
}

interface NormalizedOutput {
  title: string | null;
  language: string | null;
  cells: RawEvalCell[] | null;
  fallbackText: string;
  contentTexts: string[];
  error?: EvalNormalizedError;
}

const EvalInputSchema = z.object({
  language: z.unknown().optional(),
  code: z.string(),
  title: z.unknown().optional(),
});

const EvalCellSchema = z.object({
  id: z.union([z.string(), z.number()]).optional(),
  index: z.number().optional(),
  title: z.union([z.string(), z.null()]).optional(),
  language: z.union([z.string(), z.null()]).optional(),
  code: z.string().optional(),
  output: z.unknown().optional(),
  status: z.string().optional(),
  error: z.unknown().optional(),
});

type RawEvalCell = z.infer<typeof EvalCellSchema>;

const EvalDetailsSchema = z.object({
  title: z.union([z.string(), z.null()]).optional(),
  language: z.union([z.string(), z.null()]).optional(),
  cells: z.array(EvalCellSchema).optional(),
});

const ContentBlockSchema = z.object({
  type: z.string(),
  text: z.string().optional(),
});

const EvalOutputObjectSchema = z.object({
  title: z.union([z.string(), z.null()]).optional(),
  content: z.array(z.unknown()).optional(),
  details: EvalDetailsSchema.optional(),
  cells: z.array(EvalCellSchema).optional(),
  output: z.unknown().optional(),
  error: z.unknown().optional(),
  isError: z.boolean().optional(),
  ok: z.boolean().optional(),
});

type RawEvalOutputObject = z.infer<typeof EvalOutputObjectSchema>;

interface BuildStructuredCellsInput {
  cells: RawEvalCell[];
  inputCode: string;
  inputLanguage: string | null;
  detailsLanguage: string | null;
  contentTexts: string[];
  topError?: EvalNormalizedError;
  providerError?: unknown;
}

interface BuildStructuredCellsResult {
  cells: EvalCell[];
  error?: EvalNormalizedError;
}

export function normalizeLanguage(lang: unknown): string | null {
  if (typeof lang !== "string") {
    return null;
  }
  const trimmed = lang.trim();
  if (trimmed.length === 0) {
    return null;
  }
  const lower = trimmed.toLowerCase();
  if (lower === "js" || lower === "javascript") {
    return "js";
  }
  if (lower === "py" || lower === "python" || lower === "python3") {
    return "py";
  }
  return trimmed;
}

function parseJsonIfString(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    return value;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function isEvalToolName(toolName: string | undefined): boolean {
  if (!toolName) {
    return false;
  }
  const normalized = normalizeToolName(toolName);
  return normalized === "eval" || /(?:[.:/]|__)eval$/.test(normalized);
}

function isRecognizedEvalEnvelope(record: RawEvalOutputObject): boolean {
  const hasDetails = Boolean(record.details?.cells?.length || record.details?.title);
  const hasCells = Boolean(record.cells?.length);
  const hasContent = Boolean(record.content?.length);
  const hasOutput =
    typeof record.output === "string" ||
    typeof record.output === "number" ||
    typeof record.output === "boolean";
  const hasError = record.error !== undefined && record.error !== null && record.error !== false;
  const hasErrorFlag = record.isError === true || record.ok === false;

  return hasDetails || hasCells || hasContent || hasOutput || hasError || hasErrorFlag;
}

function formatPrimitiveOutput(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return "";
}

function resolveCellId(rawCell: RawEvalCell, fallbackIndex: number): string {
  if (typeof rawCell.id === "string" && rawCell.id.trim().length > 0) {
    return rawCell.id.trim();
  }
  if (typeof rawCell.id === "number") {
    return String(rawCell.id);
  }
  if (typeof rawCell.index === "number") {
    return `cell-${rawCell.index}`;
  }
  return `cell-${fallbackIndex}`;
}

function extractErrorOutput(errorPayload: unknown): string | null {
  if (typeof errorPayload === "string" && errorPayload.length > 0) {
    return errorPayload;
  }
  if (
    typeof errorPayload === "object" &&
    errorPayload !== null &&
    "message" in errorPayload &&
    typeof errorPayload.message === "string"
  ) {
    return errorPayload.message;
  }
  return null;
}

function parseInput(rawInput: unknown): NormalizedInput | null {
  const parsed = EvalInputSchema.safeParse(parseJsonIfString(rawInput));
  if (!parsed.success) {
    return null;
  }

  const code = parsed.data.code;
  if (code.trim().length === 0) {
    return null;
  }

  const rawTitle = parsed.data.title;
  const title = typeof rawTitle === "string" && rawTitle.trim().length > 0 ? rawTitle.trim() : null;

  return {
    code,
    language: normalizeLanguage(parsed.data.language),
    title,
  };
}

function extractContentTexts(content?: unknown[]): string[] {
  if (!content || !Array.isArray(content)) {
    return [];
  }
  return content.flatMap((item) => {
    const parsed = ContentBlockSchema.safeParse(item);
    if (parsed.success && parsed.data.type === "text" && typeof parsed.data.text === "string") {
      return [parsed.data.text];
    }
    return [];
  });
}

function resolveFallbackText(data: RawEvalOutputObject, contentTexts: string[]): string {
  if (contentTexts.length > 0) {
    return contentTexts.join("\n");
  }
  if (data.output !== undefined && data.output !== null) {
    return formatPrimitiveOutput(data.output);
  }
  if (data.error !== undefined && data.error !== null) {
    return extractErrorOutput(data.error) || "";
  }
  return "";
}

function extractEnvelopeError(
  data: RawEvalOutputObject,
  fallbackText: string,
): EvalNormalizedError | undefined {
  const hasExplicitError =
    (data.error !== undefined && data.error !== null && data.error !== false) ||
    data.isError === true ||
    data.ok === false;

  if (!hasExplicitError) {
    return undefined;
  }

  const targetPayload =
    data.error !== undefined && data.error !== null && data.error !== false ? data.error : data;
  return normalizeEvalError(targetPayload, fallbackText) ?? undefined;
}

function parseOutput(rawOutput: unknown): NormalizedOutput {
  const emptyOutput: NormalizedOutput = {
    title: null,
    language: null,
    cells: null,
    fallbackText: "",
    contentTexts: [],
  };

  if (rawOutput === null || rawOutput === undefined) {
    return emptyOutput;
  }

  const parsedJson = parseJsonIfString(rawOutput);
  const objectParsed = EvalOutputObjectSchema.safeParse(parsedJson);

  if (!objectParsed.success || !isRecognizedEvalEnvelope(objectParsed.data)) {
    return typeof rawOutput === "string"
      ? { ...emptyOutput, fallbackText: rawOutput }
      : emptyOutput;
  }

  const data = objectParsed.data;
  const contentTexts = extractContentTexts(data.content);
  const cells = data.details?.cells ?? data.cells;
  const rawTitle = data.details?.title ?? data.title;
  const title = typeof rawTitle === "string" && rawTitle.trim().length > 0 ? rawTitle.trim() : null;
  const language = normalizeLanguage(data.details?.language);

  const fallbackText = resolveFallbackText(data, contentTexts);
  const error = extractEnvelopeError(data, fallbackText);

  return {
    title,
    language,
    cells: cells && cells.length > 0 ? cells : null,
    fallbackText,
    contentTexts,
    error,
  };
}

function resolveCellOutputAndError(
  rawCell: RawEvalCell,
  primaryError?: EvalNormalizedError,
): { output: string; error?: EvalNormalizedError } {
  let output = formatPrimitiveOutput(rawCell.output);
  let error: EvalNormalizedError | undefined = undefined;

  if (rawCell.error !== undefined && rawCell.error !== null && rawCell.error !== false) {
    error = normalizeEvalError(rawCell.error, output) ?? undefined;
  } else if (rawCell.status === "failed") {
    error = (primaryError || normalizeEvalError(true, output)) ?? undefined;
  }

  const rawCellError = extractErrorOutput(rawCell.error);
  if (
    rawCellError &&
    !rawCellError.startsWith("{") &&
    !rawCellError.startsWith("Error: {") &&
    !output.includes(rawCellError)
  ) {
    output = output.length > 0 ? `${output}\n${rawCellError}` : cellErrorOutput(rawCellError);
  }

  if (error && (output.startsWith("Error: {") || output.startsWith('{"ok":false'))) {
    output = "";
  }

  return { output, error };
}

function cellErrorOutput(rawError: string): string {
  return rawError;
}

function buildSingleStructuredCell(
  rawCell: RawEvalCell,
  index: number,
  input: BuildStructuredCellsInput,
  primaryError?: EvalNormalizedError,
): EvalCell {
  const id = resolveCellId(rawCell, index);
  const title =
    typeof rawCell.title === "string" && rawCell.title.trim().length > 0
      ? rawCell.title.trim()
      : null;

  const cellLang = normalizeLanguage(rawCell.language);
  const language = cellLang ?? input.detailsLanguage ?? input.inputLanguage;
  const code = typeof rawCell.code === "string" ? rawCell.code : input.inputCode;

  const resolved = resolveCellOutputAndError(rawCell, primaryError);

  return {
    id,
    title,
    language,
    code,
    output: resolved.output,
    ...(resolved.error ? { error: resolved.error } : {}),
  };
}

function appendUnrepresentedTexts(cells: EvalCell[], contentTexts: string[]): void {
  const unrepresented = contentTexts.filter(
    (text) => !cells.some((cell) => cell.output.includes(text)),
  );
  if (unrepresented.length === 0) {
    return;
  }

  const lastCell = cells[cells.length - 1];
  if (!lastCell) {
    return;
  }

  const missingText = unrepresented.join("\n");
  if (lastCell.output.length === 0) {
    lastCell.output = missingText;
  } else if (lastCell.output.endsWith("\n")) {
    lastCell.output += missingText;
  } else {
    lastCell.output += `\n${missingText}`;
  }
}

function propagatePrimaryErrorToCells(
  cells: EvalCell[],
  rawCells: RawEvalCell[],
  primaryError: EvalNormalizedError,
): void {
  let target = cells.find((_, i) => rawCells[i]?.status === "failed");
  if (!target) {
    target = cells.find(
      (c) => typeof c.output === "string" && c.output.includes(primaryError.message),
    );
  }
  if (!target && cells.length > 0) {
    target = cells[cells.length - 1];
  }
  if (target) {
    target.error = primaryError;
    if (target.output.startsWith("Error: {") || target.output.startsWith('{"ok":false')) {
      target.output = "";
    }
  }
}

function buildStructuredCells(input: BuildStructuredCellsInput): BuildStructuredCellsResult {
  const failedCell = input.cells.find((cell) => cell.status === "failed");
  const providerContext = failedCell?.output ?? input.cells.at(-1)?.output;
  const normalizedProvider =
    input.providerError !== undefined &&
    input.providerError !== null &&
    input.providerError !== false
      ? (normalizeEvalError(input.providerError, providerContext) ?? undefined)
      : undefined;
  const primaryError = normalizedProvider || input.topError;

  const cells = input.cells.map((rawCell, index) =>
    buildSingleStructuredCell(rawCell, index, input, primaryError),
  );

  appendUnrepresentedTexts(cells, input.contentTexts);

  const hasAnyCellError = cells.some((cell) => cell.error !== undefined);
  if (!hasAnyCellError && primaryError) {
    propagatePrimaryErrorToCells(cells, input.cells, primaryError);
  }

  const aggregateError = cells.find((c) => c.error !== undefined)?.error || primaryError;

  return {
    cells,
    ...(aggregateError ? { error: aggregateError } : {}),
  };
}

export function getEvalPresentation(
  toolName: string | undefined,
  detail: ToolCallDetail | undefined,
  error?: unknown,
): EvalPresentation | null {
  if (!isEvalToolName(toolName) || detail?.type !== "unknown") {
    return null;
  }

  const input = parseInput(detail.input);
  if (!input) {
    return null;
  }

  const output = parseOutput(detail.output);
  const title = output.title ?? input.title;

  if (output.cells) {
    const result = buildStructuredCells({
      cells: output.cells,
      inputCode: input.code,
      inputLanguage: input.language,
      detailsLanguage: output.language,
      contentTexts: output.contentTexts,
      topError: output.error,
      providerError: error,
    });
    return {
      title,
      cells: result.cells,
      ...(result.error ? { error: result.error } : {}),
    };
  }

  const normalizedProvider =
    error !== undefined && error !== null && error !== false
      ? (normalizeEvalError(error, output.fallbackText) ?? undefined)
      : undefined;
  const primaryError = normalizedProvider || output.error;

  let cellOutput = output.fallbackText;
  if (primaryError && (cellOutput.startsWith("Error: {") || cellOutput.startsWith('{"ok":false'))) {
    cellOutput = "";
  }

  return {
    title,
    cells: [
      {
        id: "cell-0",
        title: input.title,
        language: output.language ?? input.language,
        code: input.code,
        output: cellOutput,
        ...(primaryError ? { error: primaryError } : {}),
      },
    ],
    ...(primaryError ? { error: primaryError } : {}),
  };
}
