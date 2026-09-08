import { existsSync, readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { setImmediate as waitForImmediate } from "node:timers/promises";
import pino from "pino";
import type { PaseoToolCatalog } from "../../tools/types.js";
import { OmpAgentClient, type OmpNoTurnScheduler, type OmpProviderIdleScheduler } from "./agent.js";
import type { OmpUsagePollScheduler } from "./usage-poller.js";
import { resolveOmpProviderParams } from "./provider-config.js";
import { FakeOmp } from "./test-utils/fake-omp.js";
import { OmpHarness } from "./test-utils/omp-harness.js";

test("OMP ready timeout defaults to 20 seconds and RPC timeout overrides both", () => {
  expect(resolveOmpProviderParams({}).runtimeProviderParams).toMatchObject({
    readyTimeoutMs: 20_000,
    rpcTimeoutMs: 60_000,
  });
  expect(resolveOmpProviderParams({ rpcTimeoutMs: 90_000 }).runtimeProviderParams).toMatchObject({
    readyTimeoutMs: 90_000,
    rpcTimeoutMs: 90_000,
  });
});

class ManualIdleScheduler implements OmpProviderIdleScheduler {
  private readonly retries: Array<() => void> = [];
  private readonly waiters: Array<{ count: number; resolve: () => void }> = [];
  private waitCount = 0;

  waitForRetry(): Promise<void> {
    this.waitCount += 1;
    for (const waiter of this.waiters.splice(0)) {
      if (this.waitCount >= waiter.count) waiter.resolve();
      else this.waiters.push(waiter);
    }
    return new Promise((resolve) => this.retries.push(resolve));
  }

  waitForWaits(count: number): Promise<void> {
    if (this.waitCount >= count) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push({ count, resolve }));
  }

  retry(): void {
    const resolve = this.retries.shift();
    if (!resolve) throw new Error("OMP has not requested an idle-state retry");
    resolve();
  }
}

class ManualNoTurnScheduler implements OmpNoTurnScheduler {
  private settleResolve: (() => void) | null = null;
  private aborted = false;

  waitForSettle(signal: AbortSignal): Promise<void> {
    if (signal.aborted) {
      this.aborted = true;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.settleResolve = resolve;
      signal.addEventListener(
        "abort",
        () => {
          this.aborted = true;
          this.settleResolve = null;
          resolve();
        },
        { once: true },
      );
    });
  }

  settle(): void {
    const resolve = this.settleResolve;
    if (!resolve) throw new Error("OMP has not requested a no-turn settle wait");
    this.settleResolve = null;
    resolve();
  }

  wasAborted(): boolean {
    return this.aborted;
  }
}

class ManualUsagePollScheduler implements OmpUsagePollScheduler {
  private readonly polls: Array<{ active: boolean; callback: () => void }> = [];

  schedulePoll(callback: () => void): () => void {
    const poll = { active: true, callback };
    this.polls.push(poll);
    return () => {
      poll.active = false;
    };
  }

  poll(): void {
    const poll = this.polls.shift();
    if (!poll) throw new Error("OMP has not scheduled a context usage poll");
    if (poll.active) poll.callback();
  }

  activePollCount(): number {
    return this.polls.filter((poll) => poll.active).length;
  }
}

function createToolCatalog(): PaseoToolCatalog {
  return {
    tools: new Map([
      [
        "create_agent",
        {
          name: "create_agent",
          description: "Create a Paseo agent.",
          handler: async () => ({ content: [] }),
        },
      ],
    ]),
    getTool: () => undefined,
    executeTool: async () => ({ content: [] }),
  };
}

describe("OMP agent client and session", () => {
  test("owns launch configuration and registers native host tools", async () => {
    const omp = new OmpHarness();
    await omp.start({ modeId: "ask" }, createToolCatalog());

    expect(omp.launchConfiguration()).toEqual({
      cwd: "/tmp/paseo-omp-agent-test",
      protocolMode: "rpc-ui",
      modeId: "ask",
      argv: ["omp", "--mode", "rpc-ui", "--approval-mode", "always-ask"],
    });
    expect(omp.registeredHostTools()).toEqual([
      [expect.objectContaining({ name: "create_agent" })],
    ]);
    expect(omp.capabilities()).toMatchObject({
      supportsMcpServers: false,
      supportsNativePaseoTools: true,
    });
  });

  test("preserves max as the selected thinking option", async () => {
    const omp = new OmpHarness();
    await omp.start({ thinkingOptionId: "max" });

    expect(omp.launchConfiguration().argv).toEqual(expect.arrayContaining(["--thinking", "max"]));
  });

  test("launches with write approval mode", async () => {
    const omp = new OmpHarness();
    await omp.start({ modeId: "write" });

    expect(omp.launchConfiguration()).toEqual({
      cwd: "/tmp/paseo-omp-agent-test",
      protocolMode: "rpc-ui",
      modeId: "write",
      argv: ["omp", "--mode", "rpc-ui", "--approval-mode", "write"],
    });
  });

  test("passes --thinking when a thinking option is provided", async () => {
    const omp = new OmpHarness();
    await omp.start({ modeId: "ask", thinkingOptionId: "xhigh" }, createToolCatalog());

    expect(omp.launchConfiguration().argv).toEqual([
      "omp",
      "--mode",
      "rpc-ui",
      "--approval-mode",
      "always-ask",
      "--thinking",
      "xhigh",
    ]);
  });

  test("streams a prompt through completion", async () => {
    const omp = new OmpHarness();
    await omp.start();

    await expect(omp.runPrompt("hello OMP", "hello from OMP")).resolves.toMatchObject({
      finalText: "hello from OMP",
    });
    expect(omp.timeline()).toEqual([
      { type: "user_message", text: "hello OMP", messageId: "user-1" },
      { type: "assistant_message", text: "hello from OMP", messageId: "omp-assistant-1" },
    ]);
    expect(omp.eventTypes().slice(0, 2)).toEqual(["turn_started", "timeline"]);
    expect(omp.completedTurnCount()).toBe(1);
  });

  test.each([undefined, "late-response-id"])(
    "keeps early assistant text in one message when message_start arrives late (responseId=%s)",
    async (responseId) => {
      const omp = new OmpHarness();
      await omp.start();
      await omp.requireStartTurn("update the block counter");
      const runtime = omp.runtime();
      runtime.beginTurn();
      runtime.emit({
        type: "message_update",
        message: { role: "assistant", content: [] },
        assistantMessageEvent: { type: "text_delta", delta: "I" },
      });
      const [firstChunk] = omp.timeline();
      expect(firstChunk).toEqual({
        type: "assistant_message",
        text: "I",
        messageId: expect.any(String),
      });
      if (firstChunk?.type !== "assistant_message") {
        throw new Error("Expected the initial assistant chunk");
      }

      runtime.emit({
        type: "message_start",
        message: { role: "assistant", content: [], responseId },
      });
      runtime.emit({
        type: "message_update",
        message: { role: "assistant", content: [], responseId },
        assistantMessageEvent: {
          type: "text_delta",
          delta: "'ll tie the block counter to debris.",
        },
      });
      runtime.emit({
        type: "message_end",
        message: { role: "assistant", content: [], responseId },
      });
      runtime.streamAssistantText("A separate response.", "next-response-id");

      expect(omp.timeline()).toEqual([
        firstChunk,
        {
          type: "assistant_message",
          text: "'ll tie the block counter to debris.",
          messageId: firstChunk.messageId,
        },
        {
          type: "assistant_message",
          text: "A separate response.",
          messageId: "next-response-id",
        },
      ]);
      runtime.finishTurn();
      await waitForImmediate();
      await omp.close();
    },
  );

  test("streams OMP advisor messages as distinct tool-call blocks", async () => {
    const omp = new OmpHarness();
    await omp.start();

    await omp.runPromptWithCustomMessage(
      "review this",
      {
        role: "custom",
        content: '<advisory severity="concern">Exercise the failure path.</advisory>',
        customType: "advisor",
        id: "advisor-live-1",
        display: true,
        details: {
          notes: [{ note: "Exercise the failure path.", severity: "concern" }],
        },
      },
      "fixed",
    );

    expect(omp.timeline()).toEqual([
      { type: "user_message", text: "review this", messageId: "user-1" },
      {
        type: "tool_call",
        callId: "omp-advisor:advisor-live-1",
        name: "advisor",
        status: "completed",
        detail: {
          type: "plain_text",
          label: "Advisor · 1 note",
          text: "[concern] Exercise the failure path.",
          icon: "brain",
        },
        metadata: {
          synthetic: true,
          source: "omp_advisor",
          noteCount: 1,
          blockerCount: 0,
        },
        error: null,
      },
      { type: "assistant_message", text: "fixed", messageId: "omp-assistant-1" },
    ]);
  });

  test("renders incoming IRC as an agent-message card without exposing its harness envelope", async () => {
    const omp = new OmpHarness();
    await omp.start();
    const content = [
      "<irc>",
      "Incoming IRC message from agent `WireGenerationCosts`:",
      "",
      "Fixed the cost calculation.\n\n- Kept the typed inputs.",
      "",
      "Sent while waiting/working. Active interruptible wait stopped early for immediate reading.",
      "",
      'If response expected, reply via `hub` (`op: "send"`, `to: "WireGenerationCosts"`); may finish current step first. No one replies on your behalf.',
      "</irc>",
    ].join("\n");
    await omp.runPromptWithCustomMessage(
      "review costs",
      {
        role: "custom",
        customType: "irc:incoming",
        id: "irc-live",
        content,
        display: true,
      },
      "Reviewed.",
    );
    omp.runtime().emit({
      type: "message_end",
      message: { role: "custom", customType: "irc:incoming", content, display: false },
    });
    expect(omp.timeline()).toEqual([
      { type: "user_message", text: "review costs", messageId: "user-1" },
      {
        type: "tool_call",
        callId: "omp-irc:irc-live",
        name: "irc",
        status: "completed",
        detail: {
          type: "plain_text",
          label: "From WireGenerationCosts",
          text: "Fixed the cost calculation.\n\n- Kept the typed inputs.",
          icon: "bot",
        },
        metadata: {
          synthetic: true,
          source: "omp_irc",
          from: "WireGenerationCosts",
          kind: "incoming",
        },
        error: null,
      },
      { type: "assistant_message", text: "Reviewed.", messageId: "omp-assistant-1" },
    ]);
    await omp.close();
  });

  test("completes a streamed assistant turn when agent_end omits messages", async () => {
    const omp = new OmpHarness();
    await omp.start();

    const { completion } = await omp.startPromptWithEmptyAgentEnd(
      "hello OMP",
      "empty terminal payload recovered",
    );
    await expect(completion).resolves.toMatchObject({
      finalText: "empty terminal payload recovered",
    });
    expect(omp.completedTurnCount()).toBe(1);
  });

  test("starts and stops context usage polling with the active turn", async () => {
    const scheduler = new ManualUsagePollScheduler();
    const omp = new OmpHarness({ usagePollScheduler: scheduler });
    await omp.start();
    omp.runtime().stats = {
      contextUsage: { tokens: 130, contextWindow: 200_000 },
    };
    omp.runtime().state.contextUsage = { tokens: 99, contextWindow: 100_000 };
    await omp.requireStartTurn("keep working");
    expect(scheduler.activePollCount()).toBe(1);
    scheduler.poll();
    await waitForImmediate();
    expect(omp.usageUpdates()).toEqual([
      {
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        totalCostUsd: 0,
        contextWindowMaxTokens: 200_000,
        contextWindowUsedTokens: 130,
      },
    ]);
    expect(scheduler.activePollCount()).toBe(1);
    omp.runtime().abortError = new Error("abort unavailable");
    await expect(omp.interrupt()).rejects.toThrow("abort unavailable");
    expect(scheduler.activePollCount()).toBe(1);
    omp.runtime().abortError = null;
    await omp.interrupt();
    expect(scheduler.activePollCount()).toBe(0);

    await omp.runPrompt("finish normally", "done");
    expect(scheduler.activePollCount()).toBe(0);

    await omp.requireStartTurn("close the session");
    expect(scheduler.activePollCount()).toBe(1);
    await omp.close();
    expect(scheduler.activePollCount()).toBe(0);
  });

  test("does not accept a follow-up until OMP reports stable idle", async () => {
    const omp = new OmpHarness();
    await omp.start();

    await omp.runPrompt("first", "first done", [
      { isStreaming: true, isCompacting: false },
      { isStreaming: false, isCompacting: false },
      { isStreaming: false, isCompacting: false },
    ]);
    await expect(omp.runPrompt("follow-up", "follow-up done")).resolves.toMatchObject({
      finalText: "follow-up done",
    });
  });

  test("stays active while OMP remains busy", async () => {
    const scheduler = new ManualIdleScheduler();
    const omp = new OmpHarness({ providerIdleScheduler: scheduler });
    await omp.start();

    const { completion } = await omp.startPromptUntilProviderIdle("first", "first done", {
      isStreaming: true,
      isCompacting: false,
    });
    await omp.waitForProviderStateChecks(2);
    await scheduler.waitForWaits(1);

    expect(omp.completedTurnCount()).toBe(0);
    scheduler.retry();
    await omp.waitForProviderStateChecks(3);
    await scheduler.waitForWaits(2);
    expect(omp.completedTurnCount()).toBe(0);

    omp.reportProviderState({ isStreaming: false, isCompacting: false });
    scheduler.retry();
    await expect(completion).resolves.toMatchObject({ finalText: "first done" });
  });

  test("stays active when OMP state checks fail", async () => {
    const scheduler = new ManualIdleScheduler();
    const omp = new OmpHarness({ providerIdleScheduler: scheduler });
    await omp.start();
    omp.failProviderStateChecks(new Error("state unavailable"));

    const { completion } = await omp.startPromptUntilProviderIdle("first", "first done", {
      isStreaming: true,
      isCompacting: false,
    });
    await omp.waitForProviderStateChecks(2);
    await scheduler.waitForWaits(1);
    expect(omp.completedTurnCount()).toBe(0);

    omp.failProviderStateChecks(null);
    omp.reportProviderState({ isStreaming: false, isCompacting: false });
    scheduler.retry();
    await expect(completion).resolves.toMatchObject({ finalText: "first done" });
  });

  test("does not complete on OMP's extension-notice agent_end", async () => {
    const omp = new OmpHarness();
    await omp.start();

    await expect(
      omp.runPromptAfterExtensionNotice("hello OMP", "model turn completed"),
    ).resolves.toMatchObject({ finalText: expect.stringContaining("model turn completed") });
    expect(omp.completedTurnCount()).toBe(1);
  });

  test.each([true, false])(
    "preserves prompt correlation when a custom notice arrives before the user echo (display=%s)",
    async (display) => {
      const omp = new OmpHarness();
      await omp.start();
      await omp.requireStartTurn("list all the skills you can access here", {
        clientMessageId: "submitted-skills",
      });

      const runtime = omp.runtime();
      runtime.emit({
        type: "message_end",
        message: {
          role: "custom",
          customType: "xdev-mount-notice",
          content: "Tool inventory changed",
          display,
        },
      });
      expect(omp.completedTurnCount()).toBe(0);

      runtime.beginTurn();
      runtime.branchMessages = [
        { entryId: "native-skills", text: "list all the skills you can access here" },
      ];
      runtime.emit({
        type: "message_end",
        message: { role: "user", content: "list all the skills you can access here" },
      });
      await waitForImmediate();
      expect(omp.timeline().filter((item) => item.type === "user_message")).toEqual([
        {
          type: "user_message",
          text: "list all the skills you can access here",
          messageId: "native-skills",
          clientMessageId: "submitted-skills",
        },
      ]);

      runtime.streamAssistantText("Here are the skills.");
      runtime.finishTurn();
      await waitForImmediate();
      expect(omp.completedTurnCount()).toBe(1);
      await omp.close();
    },
  );

  test("settles a local-only custom response through the prompt acknowledgement", async () => {
    const omp = new OmpHarness();
    await omp.start();
    const runtime = omp.runtime();
    runtime.promptAck = { agentInvoked: false };
    await omp.requireStartTurn("/extension-status", { clientMessageId: "submitted-status" });
    runtime.acceptCustomMessage("Extension is ready");
    expect(omp.completedTurnCount()).toBe(0);

    await waitForImmediate();
    expect(omp.completedTurnCount()).toBe(1);
    expect(omp.timeline()).toEqual([
      { type: "assistant_message", text: "Extension is ready" },
      {
        type: "user_message",
        text: "/extension-status",
        clientMessageId: "submitted-status",
      },
    ]);
    await omp.close();
  });

  test("omits live custom messages when display is false", async () => {
    const omp = new OmpHarness();
    await omp.start();

    await expect(
      omp.runPromptAfterExtensionNotice("hello OMP", "model turn completed", false),
    ).resolves.toMatchObject({ finalText: expect.stringContaining("model turn completed") });
    expect(omp.timeline()).toEqual([
      { type: "user_message", text: "hello OMP", messageId: "user-1" },
      {
        type: "assistant_message",
        text: "model turn completed",
        messageId: "omp-assistant-1",
      },
    ]);
  });

  test("renders a live system-notice custom message as a notification", async () => {
    const omp = new OmpHarness();
    await omp.start();

    await omp.runPrompt("hello OMP", "done");
    omp
      .runtime()
      .acceptCustomMessage(
        [
          "<system-notice>",
          "Background job DocsSmokeTwo has completed.",
          '<task-result id="DocsSmokeTwo" agent="explore" status="completed" duration="21.6s">',
          "<output>done</output>",
          "</task-result>",
          "</system-notice>",
        ].join("\n"),
      );
    omp.runtime().acceptCustomMessage("plain custom status text");

    expect(omp.timeline().filter((item) => item.type === "notification")).toEqual([
      {
        type: "notification",
        level: "info",
        message: "Background job DocsSmokeTwo completed",
      },
    ]);
    // Non-notice custom messages still fall through as assistant messages.
    expect(omp.timeline().filter((item) => item.type === "assistant_message")).toMatchObject([
      { text: "done" },
      { text: "plain custom status text" },
    ]);
  });

  test("does not complete a queued model turn from OMP's local-only hint", async () => {
    const omp = new OmpHarness();
    await omp.start();

    await expect(
      omp.runPromptAfterFalseLocalOnlyHint("hello OMP", "queued model turn completed"),
    ).resolves.toMatchObject({ finalText: "queued model turn completed" });
    expect(omp.completedTurnCount()).toBe(1);
  });

  test("completes a local-only prompt when no OMP turn begins", async () => {
    const omp = new OmpHarness();
    await omp.start();

    await expect(omp.runPromptWithoutTurn("/model")).resolves.toMatchObject({ finalText: "" });
    expect(omp.completedTurnCount()).toBe(1);
  });

  test("waits for a delayed queued model turn after OMP's local-only result", async () => {
    const omp = new OmpHarness();
    await omp.start();

    const completion = await omp.runPromptAfterDelayedFalseLocalOnlyResult(
      "hello OMP",
      "delayed queued model turn completed",
    );

    expect(completion.completedBeforeTurn).toBe(false);
    expect(completion.result).toMatchObject({ finalText: "delayed queued model turn completed" });
    expect(omp.completedTurnCount()).toBe(1);
  });

  test("completes an async local-only result after the settle window", async () => {
    const scheduler = new ManualNoTurnScheduler();
    const omp = new OmpHarness({ noTurnScheduler: scheduler });
    await omp.start();
    const prompt = await omp.startPromptWithFalseLocalOnlyResult("local-only");

    expect(prompt.completed()).toBe(false);
    scheduler.settle();
    await expect(prompt.completion).resolves.toMatchObject({ finalText: "" });
    expect(omp.completedTurnCount()).toBe(1);
  });

  test("cancels an async local-only settle when the OMP session closes", async () => {
    const scheduler = new ManualNoTurnScheduler();
    const omp = new OmpHarness({ noTurnScheduler: scheduler });
    await omp.start();
    const prompt = await omp.startPromptWithFalseLocalOnlyResult("local-only");

    await omp.close();

    expect(scheduler.wasAborted()).toBe(true);
    expect(prompt.completed()).toBe(false);
    expect(omp.completedTurnCount()).toBe(0);
  });

  test("preserves a correlated invoked result over a local-only prompt ack", async () => {
    const omp = new OmpHarness();
    await omp.start();

    const completion = await omp.runPromptAfterCorrelatedTrueResult(
      "hello OMP",
      "correlated model turn completed",
    );

    expect(completion.completedBeforeTurn).toBe(false);
    expect(completion.result).toMatchObject({ finalText: "correlated model turn completed" });
    expect(omp.completedTurnCount()).toBe(1);
  });

  test("completes an autonomous OMP turn without a foreground turn ID", async () => {
    const omp = new OmpHarness();
    await omp.start();

    await omp.runAutonomousTurn("autonomous turn completed");

    expect(omp.completedTurnCount()).toBe(1);
    expect(omp.timeline()).toContainEqual({
      type: "assistant_message",
      text: "autonomous turn completed",
      messageId: "omp-assistant-1",
    });
  });

  test("resumes an OMP session and replays its history", async () => {
    const omp = new OmpHarness();
    await omp.resume(
      {
        user: { id: "user-history", text: "continue the audit" },
        assistant: { id: "assistant-history", text: "audit context restored" },
      },
      { cwd: "/workspace/resumed", modeId: "ask", thinkingOptionId: "high" },
    );

    expect(omp.launchConfiguration()).toEqual({
      cwd: "/workspace/resumed",
      protocolMode: "rpc-ui",
      modeId: "ask",
      session: expect.stringMatching(/[\\/]paseo-omp-resume-.*[\\/]session\.jsonl$/),
      argv: [
        "omp",
        "--mode",
        "rpc-ui",
        "--approval-mode",
        "always-ask",
        "--thinking",
        "high",
        "--session",
        expect.stringMatching(/[\\/]paseo-omp-resume-.*[\\/]session\.jsonl$/),
      ],
    });
    await expect(omp.history()).resolves.toEqual([
      { type: "user_message", text: "continue the audit", messageId: "user-history" },
      {
        type: "assistant_message",
        text: "audit context restored",
        messageId: "assistant-history",
      },
    ]);
  });

  test("maps permissions and sends the selected OMP response", async () => {
    const omp = new OmpHarness();
    await omp.start();

    omp.requestToolApproval({ id: "approval-1", tool: "bash", detail: "git status" });
    expect(omp.pendingPermissions()).toEqual([
      expect.objectContaining({ id: "approval-1", name: "bash", kind: "tool" }),
    ]);

    await omp.respondToPermission("approval-1", { behavior: "allow" });
    expect(omp.extensionUiResponses()).toEqual([
      { id: "approval-1", response: { value: "Approve" } },
    ]);
  });

  test("exposes OMP modes and commands through the domain session", async () => {
    const omp = new OmpHarness();
    omp.queueCommands([{ name: "review", description: "Review changes", source: "skill" }]);
    await omp.start();

    await expect(omp.availableModes()).resolves.toEqual([
      expect.objectContaining({ id: "full" }),
      expect.objectContaining({ id: "write" }),
      expect.objectContaining({ id: "ask" }),
    ]);
    await expect(omp.commands()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "handoff" }),
        expect.objectContaining({ name: "review", kind: "skill" }),
      ]),
    );
    await expect(omp.setMode("ask")).resolves.toEqual({
      type: "warning",
      message: "Start a new OMP session to change approval mode",
    });
  });

  test("rewinds natively, interrupts, and shuts down", async () => {
    const omp = new OmpHarness();
    await omp.start();

    await omp.rewind("user-history", "from history");
    expect(omp.branchRequests()).toEqual(["user-history"]);

    await omp.interruptActiveTurn("stop me");
    expect(omp.wasAborted()).toBe(true);
    expect(omp.canceledTurnCount()).toBe(1);

    await omp.close();
    expect(omp.isClosed()).toBe(true);
  });

  test("interrupt terminalizes in-flight tool calls and running subagents", async () => {
    const omp = new OmpHarness();
    await omp.start();

    await omp.requireStartTurn("run something slow");
    const runtime = omp.runtime();
    runtime.beginTurn();
    runtime.emit({
      type: "tool_execution_start",
      toolCallId: "tool-1",
      toolName: "bash",
      args: { command: "sleep 30" },
    });
    runtime.emit({
      type: "subagent_lifecycle",
      payload: {
        id: "child-1",
        agent: "worker",
        status: "started",
        parentToolCallId: "tool-1",
        index: 0,
      },
    });
    expect(omp.runningToolCallIds()).toEqual(["tool-1"]);
    expect(omp.subagentUpserts()).toEqual([{ id: "child-1", status: "running" }]);

    await omp.interrupt();

    expect(omp.canceledTurnCount()).toBe(1);
    expect(omp.runningToolCallIds()).toEqual([]);
    expect(omp.subagentUpserts()).toEqual([
      { id: "child-1", status: "running" },
      { id: "child-1", status: "canceled" },
    ]);

    // Late progress after interrupt must not resurrect a running card.
    runtime.emit({
      type: "subagent_progress",
      payload: {
        id: "child-1",
        agent: "worker",
        index: 0,
        progress: { id: "child-1", status: "running" },
        parentToolCallId: "tool-1",
      },
    });
    expect(omp.runningToolCallIds()).toEqual([]);
  });

  test("a resumed session does not re-emit replayed events as live timeline items", async () => {
    const omp = new OmpHarness();
    await omp.resume({
      user: { id: "user-history", text: "continue the audit" },
      assistant: { id: "assistant-history", text: "audit context restored" },
    });

    const runtime = omp.runtime();
    // OMP replays pre-existing conversation on startup with --session.
    runtime.acceptPrompt("continue the audit", "user-history");
    runtime.streamAssistantText("audit context restored", "assistant-history");
    expect(omp.timeline()).toEqual([]);

    // The first live prompt flows normally.
    await expect(omp.runPrompt("next step", "on it")).resolves.toMatchObject({
      finalText: "on it",
    });
    expect(omp.timeline()).toEqual([
      { type: "user_message", text: "next step", messageId: "user-1" },
      { type: "assistant_message", text: "on it", messageId: "omp-assistant-1" },
    ]);
  });

  test("re-emitted user message_end frames dedupe by native entry id", async () => {
    const omp = new OmpHarness();
    await omp.start();

    await expect(omp.runPrompt("hello OMP", "hello from OMP")).resolves.toMatchObject({
      finalText: "hello from OMP",
    });
    // OMP can re-send message_end for an entry it already surfaced.
    omp.runtime().acceptPrompt("hello OMP", "user-1");
    expect(omp.timeline().filter((item) => item.type === "user_message")).toEqual([
      { type: "user_message", text: "hello OMP", messageId: "user-1" },
    ]);
  });

  test("enforces readOnly launch isolation, guard handshake, and denies mode changes widening tools", async () => {
    const omp = new OmpHarness();
    await omp.start({ readOnly: true });

    const launch = omp.launchConfiguration();
    expect(launch.argv).toEqual(
      expect.arrayContaining([
        "--mode",
        "rpc-ui",
        "--tools",
        "read,grep,glob",
        "--no-extensions",
        "--no-skills",
        "--no-rules",
        "--no-lsp",
      ]),
    );

    const configFlagIndex = launch.argv.indexOf("--config");
    expect(configFlagIndex).toBeGreaterThan(-1);
    const configPath = launch.argv[configFlagIndex + 1];
    expect(existsSync(configPath)).toBe(true);
    const configContent = readFileSync(configPath, "utf8");
    expect(configContent).toContain("xdev: false");
    expect(configContent).toContain("fetch:\n  enabled: false");
    expect(configContent).toContain("enableProjectConfig: false");
    expect(configContent).toContain("disabledProviders:");

    const extensionFlagIndex = launch.argv.indexOf("--extension");
    expect(extensionFlagIndex).toBeGreaterThan(-1);
    const extensionPath = launch.argv[extensionFlagIndex + 1];
    expect(existsSync(extensionPath)).toBe(true);
    const extensionContent = readFileSync(extensionPath, "utf8");
    expect(extensionContent).toContain("__paseo_readonly_guard__");
    expect(extensionContent).toContain("ALLOWED_TOOLS");
    expect(extensionContent).toContain("BLOCKED_SLASH_COMMANDS");
    const persistence = omp.describePersistence();
    expect(persistence?.metadata).toMatchObject({ readOnly: true });

    const modeChange = await omp.setMode("ask");
    expect(modeChange).toMatchObject({
      type: "warning",
      message: "Mode changes are prohibited in read-only sessions",
    });

    await omp.close();
  });

  test("fails closed if guard extension fails to load and sentinel command is missing", async () => {
    const omp = new OmpHarness();
    omp.queueCommands([]);

    await expect(omp.start({ readOnly: true })).rejects.toThrow(/sentinel command not registered/);
  });
  test("fails closed if session state reports unexpected mutating tools", async () => {
    const fakeRuntime = new FakeOmp();
    const originalStart = fakeRuntime.startSession.bind(fakeRuntime);
    fakeRuntime.startSession = async (input) => {
      const session = await originalStart(input);
      const origGetState = session.getState.bind(session);
      session.getState = async () => {
        const state = await origGetState();
        return {
          ...state,
          dumpTools: [{ name: "read" }, { name: "bash" }],
        };
      };
      return session;
    };

    const client = new OmpAgentClient({
      logger: pino({ level: "silent" }),
      runtime: fakeRuntime,
    });

    await expect(
      client.createSession({ provider: "omp", cwd: "/tmp", readOnly: true }),
    ).rejects.toThrow(/unexpected tools present \(bash\)/);
  });

  test("preserves and locks readOnly on resume, preventing widening via overrides", async () => {
    const fakeRuntime = new FakeOmp();
    const client = new OmpAgentClient({
      logger: pino({ level: "silent" }),
      runtime: fakeRuntime,
    });
    const handle = {
      provider: "omp" as const,
      sessionId: "s1",
      nativeHandle: "/tmp/session.jsonl",
      metadata: {
        cwd: "/tmp",
        readOnly: true,
      },
    };

    const session = await client.resumeSession(handle, {
      readOnly: false,
    });

    expect(session.describePersistence()?.metadata).toMatchObject({ readOnly: true });
    const latestLaunch = fakeRuntime.recordedLaunches.at(-1);
    expect(latestLaunch?.readOnly).toBe(true);
    expect(latestLaunch?.argv).toEqual(
      expect.arrayContaining(["--tools", "read,grep,glob", "--no-extensions"]),
    );

    const modeChange = await session.setMode("ask");
    expect(modeChange).toMatchObject({
      type: "warning",
      message: "Mode changes are prohibited in read-only sessions",
    });
    await session.close();
  });

  test("keeps default non-readOnly behavior unchanged", async () => {
    const omp = new OmpHarness();
    await omp.start({ modeId: "write" });

    const launch = omp.launchConfiguration();
    expect(launch.argv).toEqual(["omp", "--mode", "rpc-ui", "--approval-mode", "write"]);
    expect(launch.argv).not.toContain("--no-extensions");
    expect(launch.argv).not.toContain("--tools");
    expect(omp.describePersistence()?.metadata).not.toHaveProperty("readOnly");
    await omp.close();
  });

  test("preserves session persistence for internal readOnly sessions (does not set --no-session)", async () => {
    const omp = new OmpHarness();
    await omp.start({ internal: true, readOnly: true });

    const launch = omp.launchConfiguration();
    expect(launch.argv).not.toContain("--no-session");
    await omp.close();
  });

  test("prohibits reconfiguration slash commands in read-only startTurn", async () => {
    const omp = new OmpHarness();
    await omp.start({ readOnly: true });

    await expect(omp.startTurn("/plugin install evil")).rejects.toThrow(
      "Reconfiguration command /plugin is prohibited in read-only sessions",
    );
    await expect(omp.startTurn("/mcp add evil-server")).rejects.toThrow(
      "Reconfiguration command /mcp is prohibited in read-only sessions",
    );
    await expect(omp.startTurn("/mode plan")).rejects.toThrow(
      "Reconfiguration command /mode is prohibited in read-only sessions",
    );
    await omp.close();
  });
});
