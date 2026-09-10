import { z } from "zod";
import type { ToolCallDetail } from "@getpaseo/protocol/agent-types";
import { normalizeToolName } from "@getpaseo/protocol/tool-name-normalization";

export interface EvalCell {
  id: string;
  title: string | null;
  language: string | null;
  code: string;
  output: string;
}

export interface EvalPresentation {
  title: string | null;
  cells: EvalCell[];
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
});

type RawEvalOutputObject = z.infer<typeof EvalOutputObjectSchema>;

interface BuildStructuredCellsInput {
  cells: RawEvalCell[];
  inputCode: string;
  inputLanguage: string | null;
  detailsLanguage: string | null;
  contentTexts: string[];
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
  const hasError = record.error !== undefined && record.error !== null;

  return hasDetails || hasCells || hasContent || hasOutput || hasError;
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
  const contentTexts = (data.content ?? []).flatMap((item) => {
    const parsed = ContentBlockSchema.safeParse(item);
    if (parsed.success && parsed.data.type === "text" && typeof parsed.data.text === "string") {
      return [parsed.data.text];
    }
    return [];
  });

  const cells = data.details?.cells ?? data.cells;
  const rawTitle = data.details?.title ?? data.title;
  const title = typeof rawTitle === "string" && rawTitle.trim().length > 0 ? rawTitle.trim() : null;
  const language = normalizeLanguage(data.details?.language);

  const fallbackText =
    contentTexts.length > 0
      ? contentTexts.join("\n")
      : formatPrimitiveOutput(data.output) || extractErrorOutput(data.error) || "";

  return {
    title,
    language,
    cells: cells && cells.length > 0 ? cells : null,
    fallbackText,
    contentTexts,
  };
}

function buildStructuredCells(input: BuildStructuredCellsInput): EvalCell[] {
  const cells: EvalCell[] = input.cells.map((rawCell, index) => {
    const id = resolveCellId(rawCell, index);

    const title =
      typeof rawCell.title === "string" && rawCell.title.trim().length > 0
        ? rawCell.title.trim()
        : null;

    const cellLang = normalizeLanguage(rawCell.language);
    const language = cellLang ?? input.detailsLanguage ?? input.inputLanguage;
    const code = typeof rawCell.code === "string" ? rawCell.code : input.inputCode;

    let output = formatPrimitiveOutput(rawCell.output);
    const cellError = extractErrorOutput(rawCell.error);
    if (cellError && !output.includes(cellError)) {
      output = output.length > 0 ? `${output}\n${cellError}` : cellError;
    }

    return {
      id,
      title,
      language,
      code,
      output,
    };
  });

  const unrepresentedTexts = input.contentTexts.filter(
    (text) => !cells.some((cell) => cell.output.includes(text)),
  );

  if (unrepresentedTexts.length > 0) {
    const missingText = unrepresentedTexts.join("\n");
    const lastCell = cells[cells.length - 1];
    if (lastCell.output.length === 0) {
      lastCell.output = missingText;
    } else if (lastCell.output.endsWith("\n")) {
      lastCell.output += missingText;
    } else {
      lastCell.output += `\n${missingText}`;
    }
  }

  return cells;
}

export function getEvalPresentation(
  toolName: string | undefined,
  detail: ToolCallDetail | undefined,
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
    const cells = buildStructuredCells({
      cells: output.cells,
      inputCode: input.code,
      inputLanguage: input.language,
      detailsLanguage: output.language,
      contentTexts: output.contentTexts,
    });
    return { title, cells };
  }

  return {
    title,
    cells: [
      {
        id: "cell-0",
        title: input.title,
        language: output.language ?? input.language,
        code: input.code,
        output: output.fallbackText,
      },
    ],
  };
}
