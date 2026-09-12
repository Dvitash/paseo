import { randomUUID } from "node:crypto";
import type { CDPSession } from "@playwright/test";
import { expect, test, type Page } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import {
  expectComposerDraft,
  expectComposerVisible,
  fillComposerDraft,
} from "../support/helpers/composer";
import { seedMockAgentWorkspace, type MockAgentWorkspace } from "../support/helpers/mock-agent";
import type { SeedDaemonClient } from "../support/helpers/seed-client";
import { getServerId } from "../support/helpers/server-id";
import {
  switchWorkspaceViaSidebar,
  waitForSidebarHydration,
} from "../support/helpers/workspace-ui";

/**
 * Same-page browser memory across many large-payload workspaces.
 *
 * Twelve mock agents each stream one 512 KiB-class `read` tool payload through the
 * real timeline protocol. The browser then walks all twelve workspaces, and back,
 * entirely through sidebar SPA navigation — a single `page.goto` starts the shell
 * and nothing reloads afterwards, so one JS heap spans every sample. Sampling is
 * `HeapProfiler.collectGarbage` + `Runtime.getHeapUsage` + `Memory.getDOMCounters`
 * over CDP, plus a window sentinel minted after the initial load and re-read on
 * every sample: `Memory.getDOMCounters` alone cannot distinguish a same-heap walk
 * from a silent reload, whose fresh heap would pass as a smaller one.
 *
 * The spec asserts functional truth: the daemon timeline really carries the exact
 * payload for every agent, each workspace renders its own transcript marker, and a
 * composer draft survives the round trip. Heap, DOM-node, and rendered-character
 * numbers are recorded as observations, not budgets — a cold-eviction change is
 * judged by comparing two runs of this report.
 *
 * Payload sizes step by agent so no two transcripts are byte-identical strings,
 * which V8 could otherwise share and deduplicate after a collection.
 */

const RUN_PWA_MEMORY = process.env.PASEO_PWA_MEMORY_E2E === "1";
const memoryDescribe = RUN_PWA_MEMORY ? test.describe : test.describe.skip;

const AGENT_COUNT = 12;
const BASE_PAYLOAD_BYTES = 524_288;
const PAYLOAD_BYTE_STEP = 4_093;
// The mock provider caps its synthetic payload at 1 MiB; the largest workload here
// must stay under that or an agent's transcript would silently be a different size
// than the workload claims.
const MOCK_PAYLOAD_CEILING_BYTES = 1_000_000;
const MARKER_PREFIX = "PWA_MEMORY_MARKER";
const TITLE_PREFIX = "PWA memory workspace";
const DRAFT_TEXT = "PWA memory draft preserved across workspace revisits";
const VISIT_TIMEOUT_MS = 60_000;
const FINISH_TIMEOUT_MS = 60_000;

/**
 * Heap-identity sentinel. `Memory.getDOMCounters` alone cannot tell a same-page
 * SPA walk from a silent full reload: a reload starts a fresh document whose heap
 * counters could still look plausible. A per-run token is installed on the browser
 * window right after the initial `gotoAppShell`, and every sample reads it back.
 * A reload destroys the window object holding it, so the token mismatch fails the
 * sample that follows the reload instead of letting a fresh small heap pass as
 * evidence of retention.
 */
const HEAP_IDENTITY_KEY = "__paseoPwaMemoryHeapIdentity";

type SampleLabel =
  | "warmup"
  | "six-workspaces"
  | "twelve-workspaces"
  | "revisit-first"
  | "revisit-sweep";

interface AgentWorkload {
  expectedPayloadBytes: number;
  timelinePayloadBytes: number;
  timelineReadCallCount: number;
}

interface PwaMemorySample {
  label: SampleLabel;
  agentIndex: number;
  workspaceId: string;
  agentId: string;
  /**
   * Live value of the run's heap token at this sample, or `null` when the document
   * holding it was gone. Asserted against {@link PwaMemoryReport.heapIdentity}.
   */
  observedHeapIdentity: string | null;
  usedHeapBytes: number;
  totalHeapBytes: number;
  domNodes: number;
  documents: number;
  jsEventListeners: number;
  mountedWorkspaceEntries: number;
  renderedToolDetailChars: number;
  expectedPayloadBytes: number;
  elapsedMs: number;
}

interface HeapDelta {
  from: SampleLabel;
  to: SampleLabel;
  usedHeapBytes: number;
  domNodes: number;
}

interface PwaMemoryReport {
  agentCount: number;
  workloads: AgentWorkload[];
  totalTimelinePayloadBytes: number;
  totalTimelineReadCalls: number;
  heapIdentity: string;
  samples: PwaMemorySample[];
  heapDeltas: HeapDelta[];
}

interface GcHeapCounters {
  usedHeapBytes: number;
  totalHeapBytes: number;
  domNodes: number;
  documents: number;
  jsEventListeners: number;
}

interface TimelineItemLike {
  type: string;
  detail?: { type?: string; content?: string };
}

interface TimelineEntryLike {
  item: TimelineItemLike;
}

interface TimelinePayloadLike {
  entries: TimelineEntryLike[];
}

interface TimelinePayloadTotals {
  bytes: number;
  readCallCount: number;
}

/**
 * The seed client drives agent creation and idle waits but does not declare
 * timeline reads; callers cast the narrow slice they need, as the rewind helper does.
 */
interface TimelineReadClient {
  fetchAgentTimeline(
    agentId: string,
    options: { direction: "tail"; projection: "projected"; limit: number },
  ): Promise<TimelinePayloadLike>;
}

interface SeededScenario {
  agents: MockAgentWorkspace[];
  workloads: AgentWorkload[];
}

interface VisitOutcome {
  renderedToolDetailChars: number;
}

/**
 * Payload sizes step per agent so no two transcripts are byte-identical strings,
 * which V8 could otherwise share and deduplicate after a collection. The prompt
 * keeps the mock provider's "emit <n> byte large file agent stream payload" grammar
 * intact and appends a per-agent marker the timeline must display verbatim.
 */
const PAYLOAD_BYTES_BY_INDEX = Array.from(
  { length: AGENT_COUNT },
  (_unused, index) => BASE_PAYLOAD_BYTES + index * PAYLOAD_BYTE_STEP,
);

const PROMPT_BY_INDEX = PAYLOAD_BYTES_BY_INDEX.map(
  (bytes, index) => `emit ${bytes} byte large file agent stream payload ${MARKER_PREFIX}_${index}`,
);

function visibleChat(page: Page) {
  return page.locator('[data-testid="agent-chat-scroll"]:visible').first();
}

/**
 * Reads the live heap-identity token on the target the counters describe, through
 * the already-attached CDP session rather than a fresh DOM query. `null` means the
 * document carrying the token is gone: the page reloaded since it was minted.
 */
async function readHeapIdentity(cdp: CDPSession): Promise<string | null> {
  const { result } = await cdp.send("Runtime.evaluate", {
    expression: `window[${JSON.stringify(HEAP_IDENTITY_KEY)}] ?? null`,
    returnByValue: true,
  });
  return typeof result.value === "string" ? result.value : null;
}

async function collectGcHeapCounters(cdp: CDPSession): Promise<GcHeapCounters> {
  await cdp.send("HeapProfiler.collectGarbage");
  const heap = await cdp.send("Runtime.getHeapUsage");
  const counters = await cdp.send("Memory.getDOMCounters");
  return {
    usedHeapBytes: heap.usedSize,
    totalHeapBytes: heap.totalSize,
    domNodes: counters.nodes,
    documents: counters.documents,
    jsEventListeners: counters.jsEventListeners,
  };
}

/** Mints the run token on the window that survived the single initial navigation. */
async function establishHeapIdentity(page: Page, token: string): Promise<void> {
  const established = await page.evaluate(
    ({ key, value }) => {
      const target = window as unknown as Record<string, unknown>;
      target[key] = value;
      return target[key];
    },
    { key: HEAP_IDENTITY_KEY, value: token },
  );
  if (established !== token) {
    throw new Error(
      `Browser refused to establish the heap identity sentinel (${String(established)})`,
    );
  }
}

/** Normalizes a rejection reason at the three boundaries that report one. */
function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * Keeps the scenario failure as the reported one and still names what cleanup could
 * not remove. The primary error rides along as `cause`, and its message stays
 * verbatim at the front so assertion diffs survive.
 */
function withCleanupContext(primary: unknown, cleanupError: Error | null): Error {
  const error = toError(primary);
  if (cleanupError === null) return error;
  return new Error(`${error.message}\n\nCleanup also failed: ${cleanupError.message}`, {
    cause: error,
  });
}

async function readTimelinePayload(agent: MockAgentWorkspace): Promise<TimelinePayloadTotals> {
  const client = agent.client as SeedDaemonClient & TimelineReadClient;
  const timeline = await client.fetchAgentTimeline(agent.agentId, {
    direction: "tail",
    projection: "projected",
    limit: 0,
  });
  let bytes = 0;
  let readCallCount = 0;
  for (const entry of timeline.entries) {
    if (entry.item.type !== "tool_call" || entry.item.detail?.type !== "read") {
      continue;
    }
    readCallCount += 1;
    bytes += entry.item.detail.content?.length ?? 0;
  }
  return { bytes, readCallCount };
}

async function seedScenario(
  agents: MockAgentWorkspace[],
  workloads: AgentWorkload[],
): Promise<SeededScenario> {
  for (let index = 0; index < AGENT_COUNT; index += 1) {
    const agent = await seedMockAgentWorkspace({
      repoPrefix: `pwa-memory-${index}-`,
      title: `${TITLE_PREFIX} ${index}`,
      initialPrompt: PROMPT_BY_INDEX[index]!,
    });
    // Recorded before the idle wait so a failure mid-seed still cleans this agent up.
    agents.push(agent);

    const finish = await agent.client.waitForFinish(agent.agentId, FINISH_TIMEOUT_MS);
    if (finish.status !== "idle") {
      throw new Error(`Agent ${index} settled as ${finish.status} instead of idle`);
    }
    const payload = await readTimelinePayload(agent);
    workloads.push({
      expectedPayloadBytes: PAYLOAD_BYTES_BY_INDEX[index]!,
      timelinePayloadBytes: payload.bytes,
      timelineReadCallCount: payload.readCallCount,
    });
  }
  return { agents, workloads };
}

/**
 * Expands the agent's single tool call so the large read payload is rendered as
 * retained DOM, then reports how many characters that detail holds. Idempotent: a
 * retained workspace keeps its expanded state across visits.
 */
async function selectLargeToolData(page: Page, agent: MockAgentWorkspace): Promise<number> {
  const badge = visibleChat(page).getByTestId("tool-call-badge").last();
  await expect(badge).toBeVisible({ timeout: VISIT_TIMEOUT_MS });
  if ((await badge.locator("[data-pmono]").count()) === 0) {
    await badge.getByRole("button").first().click();
  }
  const detail = badge.locator("[data-pmono]").last();
  await expect(detail).toBeVisible({ timeout: VISIT_TIMEOUT_MS });
  const renderedChars = await detail.evaluate((node) => node.textContent?.length ?? 0);
  if (renderedChars === 0) {
    throw new Error(`Large tool data for ${agent.agentId} rendered no content`);
  }
  return renderedChars;
}

async function visitWorkspace(
  page: Page,
  agent: MockAgentWorkspace,
  index: number,
): Promise<VisitOutcome> {
  await switchWorkspaceViaSidebar({
    page,
    serverId: getServerId(),
    workspaceId: agent.workspaceId,
  });
  await expect(
    page.getByTestId(`workspace-tab-agent_${agent.agentId}`).filter({ visible: true }).first(),
  ).toBeVisible({ timeout: VISIT_TIMEOUT_MS });
  await expectComposerVisible(page, { timeout: VISIT_TIMEOUT_MS });
  await expect(visibleChat(page).getByText(PROMPT_BY_INDEX[index]!, { exact: true })).toBeVisible({
    timeout: VISIT_TIMEOUT_MS,
  });
  return { renderedToolDetailChars: await selectLargeToolData(page, agent) };
}

async function measureSample(input: {
  page: Page;
  cdp: CDPSession;
  label: SampleLabel;
  index: number;
  agent: MockAgentWorkspace;
  workload: AgentWorkload;
  visit: VisitOutcome;
  startedAt: number;
}): Promise<PwaMemorySample> {
  // The GC/heap/DOM sequence is unchanged from the baseline run so the two reports
  // stay comparable; the identity read follows it and only adds evidence.
  const counters = await collectGcHeapCounters(input.cdp);
  const observedHeapIdentity = await readHeapIdentity(input.cdp);
  const mountedWorkspaceEntries = await input.page
    .locator('[data-testid^="workspace-deck-entry-"]')
    .count();
  return {
    label: input.label,
    agentIndex: input.index,
    workspaceId: input.agent.workspaceId,
    agentId: input.agent.agentId,
    observedHeapIdentity,
    ...counters,
    mountedWorkspaceEntries,
    renderedToolDetailChars: input.visit.renderedToolDetailChars,
    expectedPayloadBytes: input.workload.expectedPayloadBytes,
    elapsedMs: Date.now() - input.startedAt,
  };
}

function buildHeapDeltas(samples: PwaMemorySample[]): HeapDelta[] {
  const deltas: HeapDelta[] = [];
  for (let index = 1; index < samples.length; index += 1) {
    const from = samples[index - 1]!;
    const to = samples[index]!;
    deltas.push({
      from: from.label,
      to: to.label,
      usedHeapBytes: to.usedHeapBytes - from.usedHeapBytes,
      domNodes: to.domNodes - from.domNodes,
    });
  }
  return deltas;
}

async function runScenario(
  page: Page,
  cdp: CDPSession,
  scenario: SeededScenario,
): Promise<PwaMemoryReport> {
  const { agents, workloads } = scenario;
  const startedAt = Date.now();
  const samples: PwaMemorySample[] = [];
  const lastIndex = AGENT_COUNT - 1;
  const heapIdentity = randomUUID();

  const recordSample = async (label: SampleLabel, index: number, visit: VisitOutcome) => {
    samples.push(
      await measureSample({
        page,
        cdp,
        label,
        index,
        agent: agents[index]!,
        workload: workloads[index]!,
        visit,
        startedAt,
      }),
    );
  };

  // Every visit goes through the sidebar, never `page.goto`, so all samples share
  // one JS heap and one set of live workspace subscriptions.
  await gotoAppShell(page);
  await waitForSidebarHydration(page);
  // Minted after the one and only navigation. Every later sample reads it back, so
  // an unnoticed reload cannot pass as a retained smaller heap.
  await establishHeapIdentity(page, heapIdentity);

  const warmup = await visitWorkspace(page, agents[0]!, 0);
  await fillComposerDraft(page, DRAFT_TEXT);
  await recordSample("warmup", 0, warmup);

  let latest = warmup;
  for (let index = 1; index <= 5; index += 1) {
    latest = await visitWorkspace(page, agents[index]!, index);
  }
  await recordSample("six-workspaces", 5, latest);

  for (let index = 6; index <= lastIndex; index += 1) {
    latest = await visitWorkspace(page, agents[index]!, index);
  }
  await recordSample("twelve-workspaces", lastIndex, latest);

  const revisitFirst = await visitWorkspace(page, agents[0]!, 0);
  await expectComposerDraft(page, DRAFT_TEXT);
  await recordSample("revisit-first", 0, revisitFirst);

  let revisitSweep = revisitFirst;
  for (const index of [1, 2]) {
    revisitSweep = await visitWorkspace(page, agents[index]!, index);
  }
  await recordSample("revisit-sweep", 2, revisitSweep);

  return {
    agentCount: AGENT_COUNT,
    workloads,
    totalTimelinePayloadBytes: workloads.reduce(
      (total, workload) => total + workload.timelinePayloadBytes,
      0,
    ),
    totalTimelineReadCalls: workloads.reduce(
      (total, workload) => total + workload.timelineReadCallCount,
      0,
    ),
    heapIdentity,
    samples,
    heapDeltas: buildHeapDeltas(samples),
  };
}

/**
 * Runs every teardown attempt to completion and reports what failed as one
 * aggregate error. The previous `Promise.allSettled` discarded rejections, so a
 * workspace that could not be removed looked like a clean run and leaked into the
 * next one. Detach failure never stops the agent cleanups.
 */
async function cleanupScenario(
  cdp: CDPSession,
  agents: MockAgentWorkspace[],
): Promise<Error | null> {
  const failures: Error[] = [];
  try {
    await cdp.detach();
  } catch (error) {
    failures.push(new Error(`CDP detach: ${toError(error).message}`));
  }
  const results = await Promise.allSettled(agents.map(async (agent) => agent.cleanup()));
  results.forEach((result, index) => {
    if (result.status !== "rejected") return;
    const agentId = agents[index]?.agentId ?? `index ${index}`;
    failures.push(
      new Error(`Agent ${agentId}: ${toError(result.reason).message}`, {
        cause: result.reason,
      }),
    );
  });
  if (failures.length === 0) return null;
  return new AggregateError(
    failures,
    // The detail is repeated in the message because an aggregate often reaches a
    // report as its message alone.
    `PWA memory cleanup failed for ${failures.length} of ${agents.length + 1} attempts: ${failures
      .map((failure) => failure.message)
      .join("; ")}`,
  );
}

memoryDescribe("PWA workspace memory", () => {
  test.describe.configure({ timeout: 600_000 });

  test("keeps one heap across twelve large-payload workspaces and verified revisits", async ({
    page,
  }, testInfo) => {
    const largestBytes = PAYLOAD_BYTES_BY_INDEX[AGENT_COUNT - 1]!;
    if (largestBytes > MOCK_PAYLOAD_CEILING_BYTES) {
      throw new Error(
        `Largest workload ${largestBytes} exceeds the mock payload ceiling ${MOCK_PAYLOAD_CEILING_BYTES}`,
      );
    }
    await page.setViewportSize({ width: 1440, height: 900 });

    const agents: MockAgentWorkspace[] = [];
    const workloads: AgentWorkload[] = [];
    const cdp = await page.context().newCDPSession(page);
    let report: PwaMemoryReport | null = null;
    let primaryError: unknown = null;
    let cleanupError: Error | null = null;

    try {
      const seeded = await seedScenario(agents, workloads);
      report = await runScenario(page, cdp, seeded);
    } catch (error) {
      primaryError = error;
    } finally {
      cleanupError = await cleanupScenario(cdp, agents);
    }

    if (primaryError) {
      throw withCleanupContext(primaryError, cleanupError);
    }
    if (!report) {
      throw withCleanupContext(new Error("PWA memory scenario produced no report"), cleanupError);
    }
    const result = report;

    // The report is attached and logged before any assertion, so a failed scenario
    // still publishes the measured samples that explain it.
    let scenarioError: Error | null = null;
    try {
      await testInfo.attach("pwa-memory", {
        body: JSON.stringify(result, null, 2),
        contentType: "application/json",
      });
      console.log(`[pwa-memory] ${JSON.stringify(result)}`);

      expect(result.workloads).toHaveLength(AGENT_COUNT);
      for (const [index, workload] of result.workloads.entries()) {
        expect(workload.timelineReadCallCount, `agent ${index} read calls`).toBe(1);
        expect(workload.timelinePayloadBytes, `agent ${index} timeline payload bytes`).toBe(
          workload.expectedPayloadBytes,
        );
      }
      expect(result.samples.map((entry) => entry.label)).toEqual([
        "warmup",
        "six-workspaces",
        "twelve-workspaces",
        "revisit-first",
        "revisit-sweep",
      ]);
      for (const entry of result.samples) {
        expect(entry.observedHeapIdentity, `${entry.label} heap identity`).toBe(
          result.heapIdentity,
        );
        expect(entry.usedHeapBytes, `${entry.label} heap`).toBeGreaterThan(0);
        expect(entry.renderedToolDetailChars, `${entry.label} rendered payload`).toBeGreaterThan(0);
      }
    } catch (error) {
      scenarioError = error instanceof Error ? error : new Error(String(error));
    }

    if (scenarioError) throw withCleanupContext(scenarioError, cleanupError);
    if (cleanupError) throw cleanupError;
  });
});
