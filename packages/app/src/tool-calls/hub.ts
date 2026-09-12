import type { TFunction } from "i18next";
import { z } from "zod";
import type { ToolCallDetail } from "@getpaseo/protocol/agent-types";
import { normalizeToolName } from "@getpaseo/protocol/tool-name-normalization";

export type HubBlockStatus =
  | "running"
  | "completed"
  | "failed"
  | "idle"
  | "delivered"
  | "ready"
  | "stopped"
  | "canceled";

export interface HubBlock {
  id: string;
  heading: string | null;
  meta: string | null;
  text: string;
  format: "prose" | "code";
  status?: string | null;
  duration?: string | null;
  previewHeading?: string | null;
  previewMeta?: string | null;
  previewText?: string | null;
  isNoResultYet?: boolean;
  omitFromPreview?: boolean;
}

export interface HubPresentation {
  summary: string;
  blocks: HubBlock[];
  op?: string;
  target?: string;
  status?: "running" | "completed" | "failed" | "canceled" | "idle";
  isProcess?: boolean;
  receiptOutcome?: string | null;
  daemonState?: string | null;
}

interface TitleKeyConfig {
  running: { target: string; bare: string };
  completed: { target: string; bare: string };
  failed: { target: string; bare: string };
}

const PROCESS_TITLE_KEYS: Record<string, TitleKeyConfig> = {
  send: {
    running: { target: "hub.title.sendingInputTo", bare: "hub.title.sendingInput" },
    completed: { target: "hub.title.inputSentTo", bare: "hub.title.inputSent" },
    failed: { target: "hub.title.sendInputFailedTo", bare: "hub.title.sendInputFailed" },
  },
  start: {
    running: { target: "hub.title.starting", bare: "hub.title.processStarting" },
    completed: { target: "hub.title.started", bare: "hub.title.processStarted" },
    failed: { target: "hub.title.startFailed", bare: "hub.title.processStartFailed" },
  },
  stop: {
    running: { target: "hub.title.stopping", bare: "hub.title.processStopping" },
    completed: { target: "hub.title.stopped", bare: "hub.title.processStopped" },
    failed: { target: "hub.title.stopFailed", bare: "hub.title.processStopFailed" },
  },
  restart: {
    running: { target: "hub.title.restarting", bare: "hub.title.processRestarting" },
    completed: { target: "hub.title.restarted", bare: "hub.title.processRestarted" },
    failed: { target: "hub.title.restartFailed", bare: "hub.title.processRestartFailed" },
  },
  describe: {
    running: { target: "hub.title.inspecting", bare: "hub.title.processInspecting" },
    completed: { target: "hub.title.described", bare: "hub.title.processDescribed" },
    failed: { target: "hub.title.describeFailed", bare: "hub.title.processDescribeFailed" },
  },
  logs: {
    running: { target: "hub.title.fetchingLogs", bare: "hub.title.processFetchingLogs" },
    completed: { target: "hub.title.logs", bare: "hub.title.processLogs" },
    failed: { target: "hub.title.logsFailed", bare: "hub.title.processLogsFailed" },
  },
};

const PEER_TITLE_KEYS: Record<string, TitleKeyConfig> = {
  send: {
    running: { target: "hub.title.sendingTo", bare: "hub.title.sending" },
    completed: { target: "hub.title.sentTo", bare: "hub.title.sent" },
    failed: { target: "hub.title.sendFailedTo", bare: "hub.title.sendFailed" },
  },
  wait: {
    running: { target: "hub.title.waitingFor", bare: "hub.title.waiting" },
    completed: { target: "hub.title.waitedFor", bare: "hub.title.waited" },
    failed: { target: "hub.title.waitFailedFor", bare: "hub.title.waitFailed" },
  },
  cancel: {
    running: { target: "hub.title.cancelling", bare: "hub.title.cancellingJobs" },
    completed: { target: "hub.title.cancelled", bare: "hub.title.jobsCancelled" },
    failed: { target: "hub.title.cancelFailedFor", bare: "hub.title.cancelFailed" },
  },
};

function resolveTitleState(hub: HubPresentation): "failed" | "running" | "completed" {
  if (hub.status === "failed") return "failed";
  if (hub.blocks.length === 1 && hub.blocks[0].id === "hub-error") return "failed";
  if (hub.status === "running") return "running";
  return "completed";
}

export function formatHubTitle(hub: HubPresentation | null | undefined, t: TFunction): string {
  if (!hub) return "";
  const op = hub.op ?? "";
  const target = hub.target ?? "";
  const state = resolveTitleState(hub);

  const table = hub.isProcess ? PROCESS_TITLE_KEYS : PEER_TITLE_KEYS;
  const config = table[op];
  if (config) {
    const keys = config[state];
    const key = target ? keys.target : keys.bare;
    if (target) {
      return t(key, { target });
    }
    return t(key);
  }

  if (op === "jobs") return t("hub.title.jobs");
  if (op === "inbox") {
    if (hub.summary.includes("peek")) return t("hub.title.inboxPeek");
    return t("hub.title.inbox");
  }
  if (op === "list") {
    if (target) return t("hub.title.agentsFiltered", { status: target });
    return t("hub.title.agents");
  }
  if (op === "ps") return t("hub.title.processes");

  if (target) return `${op || "hub"} · ${target}`;
  return op ? `hub · ${op}` : hub.summary || "hub";
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
  if (s > 0) return `${m}m ${s}s`;
  return `${m}m`;
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

function resolveActionState(
  isFailed: boolean,
  isRunning: boolean,
): "running" | "completed" | "failed" {
  if (isFailed) return "failed";
  if (isRunning) return "running";
  return "completed";
}

function isOutputRunning(output: ParsedOutput, toolStatus?: string): boolean {
  if (toolStatus === "running" || toolStatus === "executing") return true;
  return !output.contentText && !output.details && !output.isError;
}

function isProcessFailed(
  output: ParsedOutput,
  daemon: z.infer<typeof DaemonSchema>,
  toolStatus?: string,
): boolean {
  if (output.isError) return true;
  if (daemon.state === "failed") return true;
  if (daemon.exitCode !== undefined && daemon.exitCode !== 0) return true;
  return toolStatus === "failed";
}

function buildProcessSend(
  target: string,
  request: NormalizedInput,
  daemon: z.infer<typeof DaemonSchema>,
  actionState: "running" | "completed" | "failed",
  output: ParsedOutput,
): HubPresentation {
  const text = [request.text, request.keys?.join(" "), request.signal].filter(Boolean).join("\n");
  const meta = formatHubFields({ enter: request.enter });
  let sendStatus: string | null = actionState;
  if (actionState === "completed") {
    sendStatus = daemon.state ?? "delivered";
  }

  const blocks: HubBlock[] = [
    {
      id: "send-in",
      heading: target || null,
      previewHeading: null,
      meta,
      text,
      format: "code",
      status: sendStatus,
    },
  ];
  if (output.contentText) {
    blocks.push({
      id: "send-out",
      heading: null,
      meta: daemon.state ?? null,
      text: output.contentText,
      format: "code",
      omitFromPreview: true,
    });
  }
  return {
    summary: `send · ${target}`,
    blocks,
    op: "send",
    target: target || undefined,
    status: actionState,
    isProcess: true,
    daemonState: daemon.state ?? null,
  };
}

function buildProcessCommandBlock(
  op: string,
  _target: string,
  spec: z.infer<typeof SpecSchema>,
  request: NormalizedInput,
  daemonState?: string | null,
  actionState?: string,
): HubBlock | null {
  const application = spec.application ?? request.application;
  const args = spec.args ?? request.args ?? [];
  const command = [application, ...args].filter(Boolean).join(" ");
  if (!command) return null;

  let blockStatus: string | null = null;
  if (daemonState) {
    blockStatus = daemonState;
  } else if (actionState !== "completed") {
    blockStatus = actionState ?? null;
  }

  return {
    id: `${op}-cmd`,
    heading: null,
    previewHeading: null,
    meta: formatHubFields({ cwd: spec.cwd ?? request.cwd }),
    text: command,
    format: "code",
    status: blockStatus,
  };
}

function buildProcessOutputBlock(
  op: string,
  _target: string,
  outputText: string,
  details: NormalizedDetails,
  daemon: z.infer<typeof DaemonSchema>,
  request: NormalizedInput,
  hasCommand: boolean,
  actionState: string,
): HubBlock {
  const state = daemon.state ?? details.state;
  const detailMeta = formatHubFields({
    state,
    pid: daemon.pid,
    exit: daemon.exitCode,
    output: daemon.outputBytes,
    cursor: details.cursor,
    for: request.for,
    pattern: request.pattern,
    grep: request.grep,
  });

  let blockStatus: string | null = null;
  if (state) {
    blockStatus = state;
  } else if (actionState !== "completed") {
    blockStatus = actionState;
  }

  return {
    id: `${op}-out`,
    heading: null,
    meta: detailMeta,
    text: outputText,
    format: "code",
    status: blockStatus,
    ...(hasCommand && op === "start" ? { omitFromPreview: true } : {}),
  };
}

function buildProcessPresentation(
  op: string,
  input: NormalizedInput | null,
  output: ParsedOutput,
  toolStatus?: string,
): HubPresentation {
  const request = input ?? HubInputSchema.parse({});
  const details: NormalizedDetails = output.details ?? {};
  const daemon = details.daemon ?? DaemonSchema.parse({});
  const spec = details.spec ?? SpecSchema.parse({});
  const target = request.name ?? spec.name ?? daemon.name ?? "";

  const isFailed = isProcessFailed(output, daemon, toolStatus);
  const isRunning = isOutputRunning(output, toolStatus);
  const actionState = resolveActionState(isFailed, isRunning);

  if (op === "send") {
    return buildProcessSend(target, request, daemon, actionState, output);
  }

  const blocks: HubBlock[] = [];
  const cmdBlock = buildProcessCommandBlock(op, target, spec, request, daemon.state, actionState);
  if (cmdBlock) {
    blocks.push(cmdBlock);
  }
  if (output.contentText) {
    blocks.push(
      buildProcessOutputBlock(
        op,
        target,
        output.contentText,
        details,
        daemon,
        request,
        Boolean(cmdBlock),
        actionState,
      ),
    );
  }

  return {
    summary: `${op} · ${target}`,
    blocks,
    op,
    target: target || undefined,
    status: actionState,
    isProcess: true,
    daemonState: daemon.state ?? details.state ?? null,
  };
}

function isPeerSendFailed(
  output: ParsedOutput,
  outcome?: string | null,
  toolStatus?: string,
): boolean {
  if (output.isError) return true;
  if (outcome === "failed" || outcome === "rejected") return true;
  return toolStatus === "failed";
}

function resolvePeerSendStatus(
  isFailed: boolean,
  isRunning: boolean,
  outcome?: string | null,
): string {
  if (isFailed) return "failed";
  if (isRunning) return "running";
  if (outcome) return outcome;
  return "delivered";
}

function buildPeerReceiptBlocks(
  target: string,
  receipts: Array<z.infer<typeof ReceiptSchema>>,
  contentText: string,
): HubBlock[] {
  const outcome = receipts[0]?.outcome ?? null;
  if (contentText) {
    return [
      {
        id: "send-delivery",
        heading: null,
        meta: outcome,
        text: contentText,
        format: "prose",
        omitFromPreview: true,
      },
    ];
  }
  if (receipts.length > 0) {
    const text = receipts
      .map((r) => [r.to ?? target, r.outcome].filter(Boolean).join(": "))
      .join("\n");
    return [
      {
        id: "send-receipts",
        heading: null,
        meta: outcome,
        text,
        format: "prose",
        omitFromPreview: true,
      },
    ];
  }
  return [];
}

function buildPeerSend(
  input: NormalizedInput | null,
  output: ParsedOutput,
  toolStatus?: string,
): HubPresentation {
  const request = input ?? HubInputSchema.parse({});
  const receipts = output.details?.receipts ?? [];
  const target = request.to ?? receipts[0]?.to ?? "";
  const blocks: HubBlock[] = [];

  const receiptOutcome = receipts[0]?.outcome ?? null;
  const isFailed = isPeerSendFailed(output, receiptOutcome, toolStatus);
  const isRunning = isOutputRunning(output, toolStatus);
  const actionState = resolveActionState(isFailed, isRunning);
  const statusLabel = resolvePeerSendStatus(isFailed, isRunning, receiptOutcome);

  if (request.message !== undefined) {
    const detailMeta = formatHubFields({
      replyTo: request.replyTo,
      await: request.await,
    });
    const previewMeta = formatHubFields({
      replyTo: request.replyTo,
      await: request.await === true ? true : undefined,
    });
    blocks.push({
      id: "send-msg",
      heading: target || null,
      previewHeading: null,
      meta: detailMeta,
      previewMeta,
      text: request.message,
      format: "prose",
      status: statusLabel,
    });
  }

  blocks.push(...buildPeerReceiptBlocks(target, receipts, output.contentText));

  return {
    summary: `send → ${target}`,
    blocks,
    op: "send",
    target: target || undefined,
    status: actionState,
    isProcess: false,
    receiptOutcome: receiptOutcome ?? undefined,
  };
}

function buildSingleJobBlock(job: z.infer<typeof JobSchema>): HubBlock {
  const duration = formatDuration(job.durationMs);
  const meta = [job.type, job.status, duration, job.resolvedModel].filter(Boolean).join(" · ");
  const heading = job.label && job.label !== job.id ? `${job.id} (${job.label})` : job.id;
  const isRunning = job.status === "running" || job.status === "executing";
  const hasNoResult = isRunning && (!job.label || job.label === job.id) && !job.resultText;

  let text = "";
  if (job.resultText) {
    text = unwrapTaskResult(job.resultText);
  } else if (job.label && job.label !== job.id) {
    text = job.label;
  } else {
    text = job.label ?? job.status ?? "";
  }

  return {
    id: `job-${job.id}`,
    heading,
    meta: meta || null,
    previewMeta: null,
    text,
    format: "prose",
    status: job.status ?? null,
    duration: duration || null,
    isNoResultYet: hasNoResult,
  };
}

function buildSingleAgentBlock(ag: z.infer<typeof AgentSchema>): HubBlock {
  const age = formatDuration(ag.ageMs);
  const meta = [ag.parentId ? `parent: ${ag.parentId}` : null, age ? `age: ${age}` : null]
    .filter(Boolean)
    .join(" · ");
  return {
    id: `agent-${ag.id}`,
    heading: ag.id,
    meta: meta || null,
    previewMeta: null,
    text: ag.activity ?? "",
    format: "prose",
    status: "running",
    duration: age || null,
  };
}

function buildJobBlocks(output: ParsedOutput): HubBlock[] {
  const blocks: HubBlock[] = [];
  for (const job of output.details?.jobs ?? []) {
    blocks.push(buildSingleJobBlock(job));
  }
  for (const ag of output.details?.agents ?? []) {
    blocks.push(buildSingleAgentBlock(ag));
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
    const previewMeta = peer.unread ? `${peer.unread} unread` : null;
    return {
      id: `peer-${peer.id}`,
      heading: peer.id,
      meta: meta || null,
      previewMeta,
      text: peer.activity ?? "",
      format: "prose",
      status: peer.status ?? null,
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
  return {
    summary: input?.status ? `list · ${input.status}` : "list",
    blocks,
    op: "list",
    target: input?.status || undefined,
  };
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
      status: daemon.state ?? null,
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
  return { summary: "ps", blocks, op: "ps" };
}

function isWaitFailed(output: ParsedOutput, blocks: HubBlock[], toolStatus?: string): boolean {
  if (output.isError) return true;
  if (blocks.some((b) => b.status === "failed")) return true;
  return toolStatus === "failed";
}

function buildWaitPresentation(
  input: NormalizedInput | null,
  output: ParsedOutput,
  toolStatus?: string,
): HubPresentation {
  const isProcess = Boolean(
    input?.name || (output.details?.daemon && !output.details?.jobs?.length),
  );
  if (isProcess) return buildProcessPresentation("wait", input, output, toolStatus);

  let target = input?.from ?? "";
  if (input?.ids?.length) target = input.ids.join(", ");
  const blocks = buildJobBlocks(output);
  if (blocks.length === 1 && blocks[0].heading === target) {
    blocks[0].previewHeading = null;
  }

  const isFailed = isWaitFailed(output, blocks, toolStatus);
  const isRunning =
    isOutputRunning(output, toolStatus) || blocks.some((b) => b.status === "running");
  const actionState = resolveActionState(isFailed, isRunning);

  return {
    summary: target ? `wait · ${target}` : "wait",
    blocks,
    op: "wait",
    target: target || undefined,
    status: actionState,
    isProcess: false,
  };
}

function buildSendPresentation(
  input: NormalizedInput | null,
  output: ParsedOutput,
  toolStatus?: string,
): HubPresentation {
  const isProcess = Boolean(input?.name || output.details?.daemon);
  return isProcess
    ? buildProcessPresentation("send", input, output, toolStatus)
    : buildPeerSend(input, output, toolStatus);
}

function isProcessOp(op: string): boolean {
  return op === "start" || op === "stop" || op === "restart" || op === "describe" || op === "logs";
}

function buildStandardHubOp(
  op: string,
  input: NormalizedInput | null,
  output: ParsedOutput,
  status?: string,
): HubPresentation | null {
  if (op === "send") return buildSendPresentation(input, output, status);
  if (isProcessOp(op)) return buildProcessPresentation(op, input, output, status);
  if (op === "wait") return buildWaitPresentation(input, output, status);
  return null;
}

function buildBackgroundHubOp(
  op: string,
  input: NormalizedInput | null,
  output: ParsedOutput,
  actionState: "running" | "completed" | "failed",
): HubPresentation | null {
  if (op === "jobs") {
    return { summary: "jobs", blocks: buildJobBlocks(output), op: "jobs", status: actionState };
  }
  if (op === "inbox") {
    return { ...buildInboxPresentation(input, output), op: "inbox", status: actionState };
  }
  if (op === "list") {
    return {
      ...buildRosterPresentation(input, output),
      op: "list",
      target: input?.status || undefined,
      status: actionState,
    };
  }
  if (op === "ps") {
    return { ...buildProcessList(output), op: "ps", status: actionState };
  }
  if (op === "cancel") {
    const target = (input?.ids ?? []).join(", ");
    return {
      summary: ["cancel", ...(input?.ids ?? [])].join(" · "),
      blocks: [
        {
          id: "cancel",
          heading: null,
          meta: null,
          text: output.contentText,
          format: "prose",
          status: actionState,
        },
      ],
      op: "cancel",
      target: target || undefined,
      status: actionState,
    };
  }
  return null;
}

function buildHubOperation(
  op: string,
  input: NormalizedInput | null,
  output: ParsedOutput,
  status?: string,
): HubPresentation | null {
  const isFailed = output.isError || status === "failed";
  const isRunning = isOutputRunning(output, status);
  const actionState = resolveActionState(isFailed, isRunning);

  const standard = buildStandardHubOp(op, input, output, status);
  if (standard) return standard;

  const background = buildBackgroundHubOp(op, input, output, actionState);
  if (background) return background;

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
        status: actionState,
      },
    ],
    op,
    target: input?.name ?? input?.to ?? undefined,
    status: actionState,
  };
}

export function getHubPresentation(
  toolName: string | undefined,
  detail: ToolCallDetail | undefined,
  status?: string,
): HubPresentation | null {
  if (!isHubToolName(toolName) || detail?.type !== "unknown") return null;

  const input = parseInput(detail.input);
  const output = parseOutput(detail.output);
  const op = input?.op.toLowerCase() || output.details?.op?.toLowerCase() || "";

  if (!input && !output.contentText && !output.details) return null;
  const isFailed = output.isError || status === "failed";
  if (isFailed) {
    const target = input?.name ?? input?.to;
    return {
      summary: [op, target].filter(Boolean).join(" · "),
      blocks: [
        {
          id: "hub-error",
          heading: null,
          meta: null,
          text: output.contentText,
          format: "prose",
          status: "failed",
        },
      ],
      op,
      target: target || undefined,
      status: "failed",
      isProcess: Boolean(input?.name),
    };
  }

  return buildHubOperation(op, input, output, status);
}
