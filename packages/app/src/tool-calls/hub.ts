import { z } from "zod";
import type { ToolCallDetail } from "@getpaseo/protocol/agent-types";
import { normalizeToolName } from "@getpaseo/protocol/tool-name-normalization";

export interface HubBlock {
  id: string;
  heading: string | null;
  meta: string | null;
  text: string;
  format: "prose" | "code";
}
export interface HubPresentation {
  summary: string;
  blocks: HubBlock[];
}

export function hasHubContent(hub: HubPresentation | null): boolean {
  if (!hub) return false;
  return hub.blocks.some((block) => Boolean(block.heading || block.meta || block.text));
}
const StringArraySchema = z.array(z.string()).catch([]);

const HubInputSchema = z
  .object({
    op: z.string().default(""),
    to: z.string().optional(),
    name: z.string().optional(),
    message: z.string().optional(),
    await: z.boolean().optional(),
    replyTo: z.string().optional(),
    text: z.string().optional(),
    keys: StringArraySchema.optional(),
    signal: z.string().optional(),
    enter: z.boolean().optional(),
    ids: StringArraySchema.optional(),
    from: z.string().optional(),
    pattern: z.string().optional(),
    for: z.string().optional(),
    peek: z.boolean().optional(),
    status: z.string().optional(),
    application: z.string().optional(),
    args: StringArraySchema.optional(),
    cwd: z.string().optional(),
    grep: z.string().optional(),
  })
  .passthrough();

const InboxMessageSchema = z.object({
  id: z.string().optional(),
  from: z.string().default("peer"),
  to: z.string().default("me"),
  message: z.string().default(""),
  timestamp: z.number().optional(),
});
const PeerSchema = z.object({
  id: z.string().default(""),
  displayName: z.string().optional(),
  kind: z.string().optional(),
  status: z.string().optional(),
  parentId: z.string().optional(),
  unread: z.number().optional(),
  activity: z.string().optional(),
});
const CountsSchema = z.object({
  running: z.number().optional(),
  idle: z.number().optional(),
  parked: z.number().optional(),
  shown: z.number().optional(),
  truncated: z.number().optional(),
});
const JobSchema = z.object({
  id: z.string().default(""),
  type: z.string().optional(),
  status: z.string().optional(),
  label: z.string().optional(),
  durationMs: z.number().optional(),
  resolvedModel: z.string().optional(),
  resultText: z.string().optional(),
});
const AgentSchema = z.object({
  id: z.string().default(""),
  parentId: z.string().optional(),
  activity: z.string().optional(),
  ageMs: z.number().optional(),
});
const DaemonSchema = z.object({
  name: z.string().optional(),
  id: z.string().optional(),
  state: z.string().optional(),
  pid: z.number().optional(),
  exitCode: z.number().optional(),
  outputBytes: z.number().optional(),
});
const SpecSchema = z.object({
  name: z.string().optional(),
  application: z.string().optional(),
  args: StringArraySchema.optional(),
  cwd: z.string().optional(),
});
const ReceiptSchema = z.object({
  to: z.string().optional(),
  outcome: z.string().optional(),
});
const DetailsSchema = z
  .object({
    op: z.string().optional(),
    peers: z.array(PeerSchema).optional(),
    counts: CountsSchema.optional(),
    jobs: z.array(JobSchema).optional(),
    agents: z.array(AgentSchema).optional(),
    inbox: z.array(InboxMessageSchema).optional(),
    receipts: z.array(ReceiptSchema).optional(),
    daemon: DaemonSchema.optional(),
    daemons: z.array(DaemonSchema).optional(),
    spec: SpecSchema.optional(),
    cancelled: StringArraySchema.optional(),
    cursor: z.number().optional(),
    state: z.string().optional(),
  })
  .passthrough();
type NormalizedInput = z.infer<typeof HubInputSchema>;
type NormalizedDetails = z.infer<typeof DetailsSchema>;

interface ParsedOutput {
  isError: boolean;
  contentText: string;
  details: NormalizedDetails | null;
}

const HubOutputSchema = z.object({
  isError: z.boolean().optional(),
  content: z.array(z.unknown()).optional(),
  text: z.string().optional(),
  details: z.unknown().optional(),
});
const TextContentSchema = z.object({ type: z.literal("text"), text: z.string() });

const TASK_RESULT_REGEX =
  /^\s*<task-result\b[^>]*>[\s\S]*?<output>\s*([\s\S]*)<\/output>[\s\S]*?<\/task-result>/i;

export function unwrapTaskResult(text: string): string {
  const match = text.match(TASK_RESULT_REGEX);
  if (!match) return text;
  return text.replace(TASK_RESULT_REGEX, () => match[1].trim()).trim();
}

export function isHubToolName(toolName: string | undefined): boolean {
  if (!toolName) return false;
  const normalized = normalizeToolName(toolName);
  return normalized === "hub" || /(?:[.:/]|__)hub$/.test(normalized);
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  ) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return value;
    }
  }
  return value;
}

function formatDuration(ms: number | undefined): string | null {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return null;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

function formatTimestamp(ts: number | undefined): string | null {
  if (ts == null || !Number.isFinite(ts)) return null;
  try {
    return new Date(ts).toLocaleTimeString();
  } catch {
    return null;
  }
}

function parseInput(raw: unknown): NormalizedInput | null {
  const parsed = parseJson(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const res = HubInputSchema.safeParse(parsed);
  return res.success ? res.data : null;
}

function parseOutput(raw: unknown): ParsedOutput {
  const parsed = HubOutputSchema.safeParse(parseJson(raw));
  if (!parsed.success) {
    const contentText = typeof raw === "string" ? raw : "";
    return { isError: false, contentText, details: null };
  }
  const content = parsed.data.content ?? [];
  const textBlocks = content.flatMap((block) => {
    const text = TextContentSchema.safeParse(block);
    return text.success ? [text.data.text] : [];
  });
  const contentText = textBlocks.length > 0 ? textBlocks.join("\n") : (parsed.data.text ?? "");
  const details = DetailsSchema.safeParse(parseJson(parsed.data.details));
  return {
    isError: parsed.data.isError === true,
    contentText,
    details: details.success ? details.data : null,
  };
}

function formatHubFields(
  fields: Record<string, string | number | boolean | undefined>,
): string | null {
  const entries = Object.entries(fields).filter(([, value]) => value !== undefined && value !== "");
  const text = entries.map(([key, value]) => `${key}: ${value}`).join(" · ");
  return text || null;
}

function buildProcessPresentation(
  op: string,
  input: NormalizedInput | null,
  output: ParsedOutput,
): HubPresentation {
  const request = input ?? HubInputSchema.parse({});
  const details: NormalizedDetails = output.details ?? {};
  const daemon = details.daemon ?? DaemonSchema.parse({});
  const spec = details.spec ?? SpecSchema.parse({});
  const target = request.name ?? spec.name ?? daemon.name ?? "";
  const blocks: HubBlock[] = [];

  if (op === "send") {
    const text = [request.text, request.keys?.join(" "), request.signal].filter(Boolean).join("\n");
    const meta = formatHubFields({ enter: request.enter });
    blocks.push({ id: "send-in", heading: target, meta, text, format: "code" });
    if (output.contentText) {
      blocks.push({
        id: "send-out",
        heading: null,
        meta: daemon.state ?? null,
        text: output.contentText,
        format: "code",
      });
    }
    return { summary: `send · ${target}`, blocks };
  }

  const application = spec.application ?? request.application;
  const args = spec.args ?? request.args ?? [];
  const command = [application, ...args].filter(Boolean).join(" ");
  if (command) {
    const meta = formatHubFields({ cwd: spec.cwd ?? request.cwd });
    blocks.push({ id: `${op}-cmd`, heading: null, meta, text: command, format: "code" });
  }
  if (output.contentText) {
    const meta = formatHubFields({
      state: daemon.state ?? details.state,
      pid: daemon.pid,
      exit: daemon.exitCode,
      output: daemon.outputBytes,
      cursor: details.cursor,
      for: request.for,
      pattern: request.pattern,
      grep: request.grep,
    });
    blocks.push({ id: `${op}-out`, heading: null, meta, text: output.contentText, format: "code" });
  }
  return { summary: `${op} · ${target}`, blocks };
}

function buildPeerSend(input: NormalizedInput | null, output: ParsedOutput): HubPresentation {
  const request = input ?? HubInputSchema.parse({});
  const receipts = output.details?.receipts ?? [];
  const target = request.to ?? receipts[0]?.to ?? "";
  const blocks: HubBlock[] = [];
  if (request.message !== undefined) {
    const meta = formatHubFields({ replyTo: request.replyTo, await: request.await });
    blocks.push({ id: "send-msg", heading: target, meta, text: request.message, format: "prose" });
  }
  const receiptOutcome = receipts[0]?.outcome ?? null;
  if (output.contentText) {
    blocks.push({
      id: "send-delivery",
      heading: null,
      meta: receiptOutcome,
      text: output.contentText,
      format: "prose",
    });
  } else if (receipts.length > 0) {
    const text = receipts
      .map((receipt) => [receipt.to ?? target, receipt.outcome].filter(Boolean).join(": "))
      .join("\n");
    blocks.push({
      id: "send-receipts",
      heading: null,
      meta: receiptOutcome,
      text,
      format: "prose",
    });
  }
  return { summary: `send → ${target}`, blocks };
}

function buildJobBlocks(output: ParsedOutput): HubBlock[] {
  const blocks: HubBlock[] = [];
  const jobs = output.details?.jobs ?? [];
  for (const job of jobs) {
    const meta = [job.type, job.status, formatDuration(job.durationMs), job.resolvedModel]
      .filter(Boolean)
      .join(" · ");
    const heading = job.label && job.label !== job.id ? `${job.id} (${job.label})` : job.id;
    const text = job.resultText
      ? unwrapTaskResult(job.resultText)
      : (job.label ?? job.status ?? "");
    blocks.push({ id: `job-${job.id}`, heading, meta: meta || null, text, format: "prose" });
  }
  const agents = output.details?.agents ?? [];
  for (const ag of agents) {
    const age = formatDuration(ag.ageMs);
    const meta = [ag.parentId ? `parent: ${ag.parentId}` : null, age ? `age: ${age}` : null]
      .filter(Boolean)
      .join(" · ");
    blocks.push({
      id: `agent-${ag.id}`,
      heading: ag.id,
      meta: meta || null,
      text: ag.activity ?? "",
      format: "prose",
    });
  }
  if (!blocks.length && output.contentText) {
    blocks.push({
      id: "job-content",
      heading: null,
      meta: null,
      text: output.contentText,
      format: "prose",
    });
  }
  return blocks;
}

function buildInboxPresentation(
  input: NormalizedInput | null,
  output: ParsedOutput,
): HubPresentation {
  const blocks: HubBlock[] = [];
  for (const message of output.details?.inbox ?? []) {
    const meta = [message.id, formatTimestamp(message.timestamp)].filter(Boolean).join(" · ");
    blocks.push({
      id: `msg-${message.id}`,
      heading: `${message.from} → ${message.to}`,
      meta: meta || null,
      text: message.message,
      format: "prose",
    });
  }
  if (blocks.length === 0 && output.contentText) {
    blocks.push({
      id: "inbox-output",
      heading: null,
      meta: null,
      text: output.contentText,
      format: "prose",
    });
  }
  return { summary: input?.peek ? "inbox · peek" : "inbox", blocks };
}

function buildRosterPresentation(
  input: NormalizedInput | null,
  output: ParsedOutput,
): HubPresentation {
  const peers = output.details?.peers ?? [];
  const blocks: HubBlock[] = peers.map((peer) => {
    const meta = [
      peer.displayName,
      peer.kind,
      peer.status,
      peer.unread ? `${peer.unread} unread` : null,
      peer.parentId ? `parent: ${peer.parentId}` : null,
    ]
      .filter(Boolean)
      .join(" · ");
    return {
      id: `peer-${peer.id}`,
      heading: peer.id,
      meta: meta || null,
      text: peer.activity ?? "",
      format: "prose",
    };
  });
  const counts = output.details?.counts;
  if (counts?.truncated) {
    blocks.push({
      id: "list-trunc",
      heading: null,
      meta: `shown: ${counts.shown ?? peers.length} · truncated: ${counts.truncated}`,
      text: output.contentText.split("\n")[0],
      format: "prose",
    });
  }
  if (blocks.length === 0 && output.contentText) {
    blocks.push({
      id: "list-output",
      heading: null,
      meta: null,
      text: output.contentText,
      format: "prose",
    });
  }
  return { summary: input?.status ? `list · ${input.status}` : "list", blocks };
}

function buildProcessList(output: ParsedOutput): HubPresentation {
  const blocks: HubBlock[] = [];
  for (const daemon of output.details?.daemons ?? []) {
    const meta = [
      daemon.state,
      daemon.pid ? `pid: ${daemon.pid}` : null,
      daemon.exitCode !== undefined ? `exit: ${daemon.exitCode}` : null,
    ]
      .filter(Boolean)
      .join(" · ");
    blocks.push({
      id: `ps-${daemon.id ?? daemon.name}`,
      heading: daemon.name ?? null,
      meta: meta || null,
      text: daemon.id ?? "",
      format: "code",
    });
  }
  if (blocks.length === 0 && output.contentText) {
    blocks.push({
      id: "ps-output",
      heading: null,
      meta: null,
      text: output.contentText,
      format: "code",
    });
  }
  return { summary: "ps", blocks };
}

function buildWaitPresentation(
  input: NormalizedInput | null,
  output: ParsedOutput,
): HubPresentation {
  const isProcess = Boolean(
    input?.name || (output.details?.daemon && !output.details?.jobs?.length),
  );
  if (isProcess) return buildProcessPresentation("wait", input, output);
  let target = input?.from ?? "";
  if (input?.ids?.length) target = input.ids.join(", ");
  return { summary: target ? `wait · ${target}` : "wait", blocks: buildJobBlocks(output) };
}

function buildSendPresentation(
  input: NormalizedInput | null,
  output: ParsedOutput,
): HubPresentation {
  const isProcess = Boolean(input?.name || output.details?.daemon);
  return isProcess ? buildProcessPresentation("send", input, output) : buildPeerSend(input, output);
}

function buildHubOperation(
  op: string,
  input: NormalizedInput | null,
  output: ParsedOutput,
): HubPresentation | null {
  switch (op) {
    case "send":
      return buildSendPresentation(input, output);
    case "start":
    case "stop":
    case "restart":
    case "describe":
    case "logs":
      return buildProcessPresentation(op, input, output);
    case "wait":
      return buildWaitPresentation(input, output);
    case "jobs":
      return { summary: "jobs", blocks: buildJobBlocks(output) };
    case "inbox":
      return buildInboxPresentation(input, output);
    case "list":
      return buildRosterPresentation(input, output);
    case "ps":
      return buildProcessList(output);
    case "cancel":
      return {
        summary: ["cancel", ...(input?.ids ?? [])].join(" · "),
        blocks: [
          { id: "cancel", heading: null, meta: null, text: output.contentText, format: "prose" },
        ],
      };
    default:
      if (!output.contentText) return null;
      return {
        summary: op ? `hub · ${op}` : "hub",
        blocks: [
          {
            id: "hub-output",
            heading: null,
            meta: null,
            text: output.contentText,
            format: "prose",
          },
        ],
      };
  }
}

export function getHubPresentation(
  toolName: string | undefined,
  detail: ToolCallDetail | undefined,
): HubPresentation | null {
  if (!isHubToolName(toolName) || detail?.type !== "unknown") return null;

  const input = parseInput(detail.input);
  const output = parseOutput(detail.output);
  const op = input?.op.toLowerCase() || output.details?.op?.toLowerCase() || "";

  if (!input && !output.contentText && !output.details) return null;
  if (output.isError) {
    return {
      summary: [op, input?.name ?? input?.to].filter(Boolean).join(" · "),
      blocks: [
        { id: "hub-error", heading: null, meta: null, text: output.contentText, format: "prose" },
      ],
    };
  }

  return buildHubOperation(op, input, output);
}
