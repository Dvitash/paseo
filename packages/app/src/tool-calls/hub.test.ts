import { describe, expect, it } from "vitest";
import type { ToolCallDetail } from "@getpaseo/protocol/agent-types";
import { i18n } from "@/i18n/i18next";
import { formatHubTitle, getHubPresentation, isHubToolName, unwrapTaskResult } from "./hub";

const t = i18n.t.bind(i18n);
describe("isHubToolName", () => {
  it("matches exact 'hub' and 'functions.hub'", () => {
    expect(isHubToolName("hub")).toBe(true);
    expect(isHubToolName("HUB")).toBe(true);
    expect(isHubToolName("  hub  ")).toBe(true);
    expect(isHubToolName("functions.hub")).toBe(true);
    expect(isHubToolName("functions.HUB")).toBe(true);
  });

  it("matches namespaced hub tool names", () => {
    expect(isHubToolName("mcp__hub")).toBe(true);
    expect(isHubToolName("ns:hub")).toBe(true);
    expect(isHubToolName("paseo.hub")).toBe(true);
  });

  it("rejects non-hub or arbitrary substring tool names", () => {
    expect(isHubToolName(undefined)).toBe(false);
    expect(isHubToolName("")).toBe(false);
    expect(isHubToolName("github")).toBe(false);
    expect(isHubToolName("hubbub")).toBe(false);
    expect(isHubToolName("chubby")).toBe(false);
    expect(isHubToolName("custom_hub")).toBe(false);
    expect(isHubToolName("eval")).toBe(false);
    expect(isHubToolName("read")).toBe(false);
    expect(isHubToolName("bash")).toBe(false);
  });
});

describe("unwrapTaskResult", () => {
  it("unwraps <task-result><output>...</output></task-result> wrappers", () => {
    const raw = `<task-result id="Scout1" agent="scout" status="completed" duration="1m32s">
<meta lines="26" size="2.9KB" />
<output>
{
  "summary": "Completed successfully"
}
</output>
</task-result>

Scout1 is now idle — message it via \`hub\``;

    const unwrapped = unwrapTaskResult(raw);
    expect(unwrapped).toContain('{\n  "summary": "Completed successfully"\n}');
    expect(unwrapped).toContain("Scout1 is now idle");
    expect(unwrapped).not.toContain("<task-result");
    expect(unwrapped).not.toContain("</output>");
  });

  it("does not strip unrelated user XML tags", () => {
    const textWithXml = "<div>Hello <span>world</span></div>\n<custom-tag>important</custom-tag>";
    expect(unwrapTaskResult(textWithXml)).toBe(textWithXml);
  });

  it("preserves literal closing tags and replacement tokens inside the output", () => {
    const body = 'Print "</output>" and "</task-result>" literally, along with $& and $1.';
    const wrapped = `<task-result id="Worker"><output>${body}</output></task-result>`;
    expect(unwrapTaskResult(wrapped)).toBe(body);
  });

  it("leaves task-result examples embedded in prose unchanged", () => {
    const prose = "Example: <task-result><output>content</output></task-result>";
    expect(unwrapTaskResult(prose)).toBe(prose);
  });

  it("returns plain text unchanged", () => {
    const plain = "Simple plain text message without XML.";
    expect(unwrapTaskResult(plain)).toBe(plain);
  });
});

describe("getHubPresentation", () => {
  describe("filtering and malformed detail handling", () => {
    it("returns null for non-hub tool names", () => {
      const detail: ToolCallDetail = {
        type: "unknown",
        input: { op: "inbox" },
        output: { details: { inbox: [] } },
      };
      expect(getHubPresentation("eval", detail)).toBeNull();
      expect(getHubPresentation(undefined, detail)).toBeNull();
      expect(getHubPresentation("github", detail)).toBeNull();
    });

    it("returns null for non-unknown detail types", () => {
      const shellDetail: ToolCallDetail = {
        type: "shell",
        command: "hub list",
      };
      expect(getHubPresentation("hub", shellDetail)).toBeNull();
    });

    it("returns null when unknown operation has no readable output so raw debug remains", () => {
      const detail: ToolCallDetail = {
        type: "unknown",
        input: null,
        output: null,
      };
      expect(getHubPresentation("hub", detail)).toBeNull();
    });

    it("returns fallback presentation when unknown operation has readable output", () => {
      const detail: ToolCallDetail = {
        type: "unknown",
        input: { op: "custom_op" },
        output: { content: [{ type: "text", text: "Custom operation finished" }] },
      };
      const presentation = getHubPresentation("hub", detail);
      expect(presentation).not.toBeNull();
      expect(presentation?.summary).toBe("hub · custom_op");
      expect(presentation?.blocks[0].text).toBe("Custom operation finished");
      expect(presentation?.blocks[0].text).not.toContain("[object Object]");
    });

    it("handles stringified JSON input and stringified JSON output", () => {
      const detail: ToolCallDetail = {
        type: "unknown",
        input: JSON.stringify({ op: "inbox", peek: true }),
        output: JSON.stringify({
          content: [{ type: "text", text: "Inbox empty." }],
          details: { inbox: [] },
        }),
      };
      const presentation = getHubPresentation("hub", detail);
      expect(presentation).not.toBeNull();
      expect(presentation?.summary).toBe("inbox · peek");
      expect(presentation?.blocks[0].text).toBe("Inbox empty.");
    });

    it("handles raw string output without throwing", () => {
      const detail: ToolCallDetail = {
        type: "unknown",
        input: { op: "inbox" },
        output: "Raw terminal output without JSON envelope",
      };
      const presentation = getHubPresentation("hub", detail);
      expect(presentation?.summary).toBe("inbox");
      expect(presentation?.blocks[0].text).toBe("Raw terminal output without JSON envelope");
    });
  });

  describe("op: send", () => {
    it("parses peer messaging with outbound message and delivery receipt", () => {
      const detail: ToolCallDetail = {
        type: "unknown",
        input: {
          op: "send",
          to: "WorkerAgent",
          message: "Please review the diff.",
          replyTo: "msg-1234",
          await: true,
        },
        output: {
          content: [{ type: "text", text: "Delivered to 1 peer(s):\n- WorkerAgent: injected" }],
          details: {
            op: "send",
            to: "WorkerAgent",
            receipts: [{ to: "WorkerAgent", outcome: "injected" }],
          },
        },
      };

      const presentation = getHubPresentation("hub", detail);
      expect(presentation?.summary).toBe("send → WorkerAgent");
      const blocks = presentation?.blocks ?? [];
      expect(blocks).toHaveLength(2);

      const [msgBlock, receiptBlock] = blocks;
      expect(msgBlock.heading).toBe("WorkerAgent");
      expect(msgBlock.meta).toBe("replyTo: msg-1234 · await: true");
      expect(msgBlock.text).toBe("Please review the diff.");
      expect(msgBlock.format).toBe("prose");

      expect(receiptBlock.heading).toBeNull();
      expect(receiptBlock.meta).toBe("injected");
      expect(receiptBlock.text).toContain("Delivered to 1 peer(s)");
      expect(receiptBlock.format).toBe("prose");
    });

    it("parses process control send with input command and daemon status", () => {
      const detail: ToolCallDetail = {
        type: "unknown",
        input: {
          op: "send",
          name: "web-server",
          text: "rs\n",
          keys: ["ENTER"],
          signal: "SIGINT",
          enter: true,
        },
        output: {
          content: [{ type: "text", text: "Sent input to web-server: ready pid=20755" }],
          details: {
            op: "send",
            daemon: {
              name: "web-server",
              id: "daemon-uuid-1",
              state: "ready",
              pid: 20755,
            },
          },
        },
      };

      const presentation = getHubPresentation("hub", detail);
      expect(presentation?.summary).toBe("send · web-server");
      const blocks = presentation?.blocks ?? [];
      expect(blocks).toHaveLength(2);

      const [inputBlock, statusBlock] = blocks;
      expect(inputBlock.heading).toBe("web-server");
      expect(inputBlock.meta).toBe("enter: true");
      expect(inputBlock.text).toBe("rs\n\nENTER\nSIGINT");
      expect(inputBlock.format).toBe("code");

      expect(statusBlock.heading).toBeNull();
      expect(statusBlock.meta).toBe("ready");
      expect(statusBlock.text).toContain("Sent input to web-server");
      expect(statusBlock.format).toBe("code");
    });
  });

  describe("op: wait", () => {
    it("parses job/peer wait with structured jobs, unwrapped task results, and unbacked agents", () => {
      const detail: ToolCallDetail = {
        type: "unknown",
        input: {
          op: "wait",
          ids: ["TaskScout", "BuildJob"],
          from: "TaskScout",
          timeoutMs: 60000,
        },
        output: {
          details: {
            op: "wait",
            jobs: [
              {
                id: "TaskScout",
                type: "task",
                status: "completed",
                label: "TaskScout",
                durationMs: 92350,
                resolvedModel: "gemini-3.7-flash",
                resultText: `<task-result id="TaskScout" status="completed">
<output>
Parsed successfully without errors.
</output>
</task-result>

TaskScout is now idle`,
              },
              {
                id: "BuildJob",
                type: "bash",
                status: "running",
                durationMs: 15000,
              },
            ],
            agents: [
              {
                id: "UnbackedMonitor",
                parentId: "Main",
                activity: "Listening on socket",
                ageMs: 45000,
              },
            ],
          },
        },
      };

      const presentation = getHubPresentation("hub", detail);
      expect(presentation?.summary).toBe("wait · TaskScout, BuildJob");
      const blocks = presentation?.blocks ?? [];
      expect(blocks).toHaveLength(3);

      const [job1, job2, agent1] = blocks;
      expect(job1.heading).toBe("TaskScout");
      expect(job1.meta).toBe("task · completed · 1m 32s · gemini-3.7-flash");
      expect(job1.text).toBe("Parsed successfully without errors.\n\nTaskScout is now idle");
      expect(job1.format).toBe("prose");

      expect(job2.heading).toBe("BuildJob");
      expect(job2.meta).toBe("bash · running · 15s");
      expect(job2.format).toBe("prose");

      expect(agent1.heading).toBe("UnbackedMonitor");
      expect(agent1.meta).toBe("parent: Main · age: 45s");
      expect(agent1.text).toBe("Listening on socket");
      expect(agent1.format).toBe("prose");
    });

    it("parses process lifecycle wait", () => {
      const detail: ToolCallDetail = {
        type: "unknown",
        input: {
          op: "wait",
          name: "vite-dev",
          pattern: "ready in",
          for: "ready",
          timeout: 30,
        },
        output: {
          content: [{ type: "text", text: "vite-dev: ready pid=1234\nMatched: ready in" }],
          details: {
            op: "wait",
            daemon: {
              name: "vite-dev",
              id: "uuid-vite",
              state: "ready",
              pid: 1234,
            },
          },
        },
      };

      const presentation = getHubPresentation("hub", detail);
      expect(presentation?.summary).toBe("wait · vite-dev");
      expect(presentation?.blocks).toHaveLength(1);

      const block = presentation?.blocks[0];
      expect(block?.heading).toBeNull();
      expect(block?.meta).toBe("state: ready · pid: 1234 · for: ready · pattern: ready in");
      expect(block?.text).toContain("Matched: ready in");
      expect(block?.format).toBe("code");
    });
  });

  describe("op: inbox", () => {
    it("renders per-message headings and body when inbox has messages", () => {
      const detail: ToolCallDetail = {
        type: "unknown",
        input: { op: "inbox" },
        output: {
          details: {
            op: "inbox",
            inbox: [
              {
                id: "msg-001",
                from: "Alice",
                to: "Bob",
                message: "Hello Bob, please verify the changes.",
                timestamp: 1786887780000,
              },
              {
                id: "msg-002",
                from: "Charlie",
                to: "Bob",
                message: "Deployment ready.",
              },
            ],
          },
        },
      };

      const presentation = getHubPresentation("hub", detail);
      expect(presentation?.summary).toBe("inbox");
      expect(presentation?.blocks).toHaveLength(2);

      const [msg1, msg2] = presentation!.blocks;
      expect(msg1.heading).toBe("Alice → Bob");
      expect(msg1.meta).toContain("msg-001");
      expect(msg1.text).toBe("Hello Bob, please verify the changes.");
      expect(msg1.format).toBe("prose");

      expect(msg2.heading).toBe("Charlie → Bob");
      expect(msg2.text).toBe("Deployment ready.");
    });

    it("renders 'Inbox empty.' fallback when inbox is empty", () => {
      const detail: ToolCallDetail = {
        type: "unknown",
        input: { op: "inbox", peek: true },
        output: {
          content: [{ type: "text", text: "Inbox empty." }],
          details: {
            op: "inbox",
            inbox: [],
          },
        },
      };

      const presentation = getHubPresentation("hub", detail);
      expect(presentation?.summary).toBe("inbox · peek");
      expect(presentation?.blocks).toHaveLength(1);
      expect(presentation?.blocks[0].text).toBe("Inbox empty.");
      expect(presentation?.blocks[0].heading).toBeNull();
      expect(presentation?.blocks[0].format).toBe("prose");
    });
  });

  describe("op: list", () => {
    it("renders peer roster with status, activity, and truncation notices", () => {
      const detail: ToolCallDetail = {
        type: "unknown",
        input: { op: "list", status: "running" },
        output: {
          content: [{ type: "text", text: "5 peer(s) omitted (2 running, 1 idle, 5 parked)." }],
          details: {
            op: "list",
            peers: [
              {
                id: "Worker1",
                displayName: "scout",
                kind: "sub",
                status: "running",
                parentId: "Main",
                unread: 3,
                activity: "Grep for error logs",
              },
              {
                id: "Main",
                displayName: "main",
                kind: "main",
                status: "running",
                unread: 0,
              },
            ],
            counts: {
              running: 2,
              idle: 1,
              parked: 5,
              shown: 2,
              truncated: 5,
            },
          },
        },
      };

      const presentation = getHubPresentation("hub", detail);
      expect(presentation?.summary).toBe("list · running");
      const blocks = presentation?.blocks ?? [];
      expect(blocks).toHaveLength(3);

      const [peer1, peer2, truncationNotice] = blocks;
      expect(peer1.heading).toBe("Worker1");
      expect(peer1.meta).toBe("scout · sub · running · 3 unread · parent: Main");
      expect(peer1.text).toBe("Grep for error logs");

      expect(peer2.heading).toBe("Main");
      expect(peer2.meta).toBe("main · main · running");

      expect(truncationNotice.heading).toBeNull();
      expect(truncationNotice.meta).toBe("shown: 2 · truncated: 5");
      expect(truncationNotice.text).toBe("5 peer(s) omitted (2 running, 1 idle, 5 parked).");
    });

    it("renders 'No peers found.' when roster is empty", () => {
      const detail: ToolCallDetail = {
        type: "unknown",
        input: { op: "list" },
        output: {
          content: [{ type: "text", text: "No peers found." }],
          details: {
            op: "list",
            peers: [],
          },
        },
      };

      const presentation = getHubPresentation("hub", detail);
      expect(presentation?.summary).toBe("list");
      expect(presentation?.blocks[0].text).toBe("No peers found.");
    });
  });

  describe("op: jobs", () => {
    it("renders structured jobs snapshot", () => {
      const detail: ToolCallDetail = {
        type: "unknown",
        input: { op: "jobs" },
        output: {
          details: {
            op: "jobs",
            jobs: [
              {
                id: "JobA",
                type: "task",
                status: "running",
                durationMs: 45000,
              },
            ],
          },
        },
      };

      const presentation = getHubPresentation("hub", detail);
      expect(presentation?.summary).toBe("jobs");
      expect(presentation?.blocks).toHaveLength(1);
      expect(presentation?.blocks[0].heading).toBe("JobA");
      expect(presentation?.blocks[0].meta).toBe("task · running · 45s");
    });

    it("renders fallback when jobs are empty", () => {
      const detail: ToolCallDetail = {
        type: "unknown",
        input: { op: "jobs" },
        output: {
          content: [{ type: "text", text: "No active jobs." }],
          details: {
            op: "jobs",
            jobs: [],
          },
        },
      };

      const presentation = getHubPresentation("hub", detail);
      expect(presentation?.summary).toBe("jobs");
      expect(presentation?.blocks[0].text).toBe("No active jobs.");
    });
  });

  describe("op: cancel", () => {
    it("renders readable output and cancelled target IDs", () => {
      const detail: ToolCallDetail = {
        type: "unknown",
        input: { op: "cancel", ids: ["bg-1", "bg-2"] },
        output: {
          content: [{ type: "text", text: "Cancelled background jobs bg-1, bg-2." }],
          details: {
            op: "cancel",
            cancelled: ["bg-1", "bg-2"],
          },
        },
      };

      const presentation = getHubPresentation("hub", detail);
      expect(presentation?.summary).toBe("cancel · bg-1 · bg-2");
      expect(presentation?.blocks).toHaveLength(1);
      expect(presentation?.blocks[0].heading).toBeNull();
      expect(presentation?.blocks[0].meta).toBeNull();
      expect(presentation?.blocks[0].text).toContain("Cancelled background jobs bg-1, bg-2.");
    });
  });

  describe("op: start", () => {
    it("renders visible command from input, state/pid metadata, and does not expose env", () => {
      const detail: ToolCallDetail = {
        type: "unknown",
        input: {
          op: "start",
          name: "web-app",
          application: "bun",
          args: ["run", "start"],
          env: { SECRET_API_KEY: "super_secret_value", PORT: "3000" },
          cwd: "/workspace/project",
        },
        output: {
          content: [
            { type: "text", text: "Started web-app: ready pid=9998\nListening on port 3000" },
          ],
          details: {
            op: "start",
            daemon: {
              name: "web-app",
              state: "ready",
              pid: 9998,
              startedAt: 1785350209000,
            },
          },
        },
      };

      const presentation = getHubPresentation("hub", detail);
      expect(presentation?.summary).toBe("start · web-app");
      const blocks = presentation?.blocks ?? [];
      expect(blocks).toHaveLength(2);

      const [commandBlock, outputBlock] = blocks;
      expect(commandBlock.heading).toBeNull();
      expect(commandBlock.text).toBe("bun run start");
      expect(commandBlock.meta).toBe("cwd: /workspace/project");
      expect(commandBlock.format).toBe("code");

      // Verify env secrets are not exposed in block texts or headings
      let allText = "";
      for (const b of blocks) {
        allText += `${b.heading} ${b.meta} ${b.text}\n`;
      }
      expect(allText).not.toContain("super_secret_value");

      expect(outputBlock.heading).toBeNull();
      expect(outputBlock.meta).toBe("state: ready · pid: 9998");
      expect(outputBlock.text).toContain("Listening on port 3000");
      expect(outputBlock.format).toBe("code");
    });
  });

  describe("op: ps", () => {
    it("prefers input.op 'ps' over details.op 'list' and renders structured daemon rows", () => {
      const detail: ToolCallDetail = {
        type: "unknown",
        input: { op: "ps" },
        output: {
          content: [{ type: "text", text: "- lsp: ready pid=551152" }],
          details: {
            op: "list", // Notice transcript uses details.op = 'list' for ps!
            daemons: [
              {
                name: "lsp",
                id: "uuid-lsp",
                state: "ready",
                pid: 551152,
              },
              {
                name: "compiler",
                id: "uuid-compiler",
                state: "exited",
                exitCode: 0,
              },
            ],
          },
        },
      };

      const presentation = getHubPresentation("hub", detail);
      expect(presentation?.summary).toBe("ps");
      const blocks = presentation?.blocks ?? [];
      expect(blocks).toHaveLength(2);

      const [daemon1, daemon2] = blocks;
      expect(daemon1.heading).toBe("lsp");
      expect(daemon1.meta).toBe("ready · pid: 551152");
      expect(daemon1.format).toBe("code");

      expect(daemon2.heading).toBe("compiler");
      expect(daemon2.meta).toBe("exited · exit: 0");
    });
  });

  describe("op: logs", () => {
    it("renders raw monospaced terminal logs", () => {
      const rawLogs = `[12:00:01] Starting server...
[12:00:02] Connected to database
[12:00:05] GET /api/health 200`;

      const detail: ToolCallDetail = {
        type: "unknown",
        input: {
          op: "logs",
          name: "web-server",
          grep: "GET",
        },
        output: {
          content: [{ type: "text", text: rawLogs }],
          details: {
            op: "logs",
            cursor: 47209,
            state: "ready",
          },
        },
      };

      const presentation = getHubPresentation("hub", detail);
      expect(presentation?.summary).toBe("logs · web-server");
      expect(presentation?.blocks).toHaveLength(1);

      const block = presentation?.blocks[0];
      expect(block?.heading).toBeNull();
      expect(block?.meta).toBe("state: ready · cursor: 47209 · grep: GET");
      expect(block?.text).toBe(rawLogs);
    });
  });

  describe("op: stop", () => {
    it("renders process stop result with exit code", () => {
      const detail: ToolCallDetail = {
        type: "unknown",
        input: { op: "stop", name: "redis" },
        output: {
          content: [{ type: "text", text: "Stopped redis: exited exit=143" }],
          details: {
            op: "stop",
            daemon: {
              name: "redis",
              state: "exited",
              exitCode: 143,
            },
          },
        },
      };

      const presentation = getHubPresentation("hub", detail);
      expect(presentation?.summary).toBe("stop · redis");
      expect(presentation?.blocks).toHaveLength(1);

      const block = presentation?.blocks[0];
      expect(block?.heading).toBeNull();
      expect(block?.meta).toBe("state: exited · exit: 143");
      expect(block?.text).toContain("Stopped redis");
    });
  });

  describe("op: restart", () => {
    it("renders process restart result with state and PID", () => {
      const detail: ToolCallDetail = {
        type: "unknown",
        input: { op: "restart", name: "rojo" },
        output: {
          content: [{ type: "text", text: "Restarted rojo: starting pid=400689" }],
          details: {
            op: "restart",
            daemon: {
              name: "rojo",
              state: "starting",
              pid: 400689,
            },
          },
        },
      };

      const presentation = getHubPresentation("hub", detail);
      expect(presentation?.summary).toBe("restart · rojo");
      expect(presentation?.blocks).toHaveLength(1);

      const block = presentation?.blocks[0];
      expect(block?.heading).toBeNull();
      expect(block?.meta).toBe("state: starting · pid: 400689");
      expect(block?.text).toContain("Restarted rojo");
    });
  });

  describe("op: describe", () => {
    it("renders process spec command, cwd, and status", () => {
      const detail: ToolCallDetail = {
        type: "unknown",
        input: { op: "describe", name: "test-runner" },
        output: {
          content: [{ type: "text", text: "test-runner: exited exit=0 uptime=56ms" }],
          details: {
            op: "describe",
            daemon: {
              name: "test-runner",
              state: "exited",
              exitCode: 0,
              outputBytes: 7782,
            },
            spec: {
              name: "test-runner",
              application: "git",
              args: ["status", "--short"],
              cwd: "/home/user/repo",
            },
          },
        },
      };

      const presentation = getHubPresentation("hub", detail);
      expect(presentation?.summary).toBe("describe · test-runner");
      const blocks = presentation?.blocks ?? [];
      expect(blocks).toHaveLength(2);

      const [cmdBlock, statusBlock] = blocks;
      expect(cmdBlock.heading).toBeNull();
      expect(cmdBlock.text).toBe("git status --short");
      expect(cmdBlock.meta).toBe("cwd: /home/user/repo");
      expect(cmdBlock.format).toBe("code");

      expect(statusBlock.heading).toBeNull();
      expect(statusBlock.meta).toBe("state: exited · exit: 0 · output: 7782");
      expect(statusBlock.text).toContain("test-runner: exited");
    });
  });

  describe("failures, errors, and boundary limits", () => {
    it("handles error envelopes with content text cleanly", () => {
      const detail: ToolCallDetail = {
        type: "unknown",
        input: { op: "describe" },
        output: {
          isError: true,
          content: [{ type: "text", text: "describe requires name" }],
          details: {},
        },
      };

      const presentation = getHubPresentation("hub", detail);
      expect(presentation?.summary).toBe("describe");
      expect(presentation?.blocks[0].heading).toBeNull();
      expect(presentation?.blocks[0].text).toBe("describe requires name");
    });

    it("preserves long text (>100k chars) intact at presentation model boundary", () => {
      const giantText = "A".repeat(120_000);
      const detail: ToolCallDetail = {
        type: "unknown",
        input: {
          op: "wait",
          ids: ["GiantTask"],
        },
        output: {
          details: {
            op: "wait",
            jobs: [
              {
                id: "GiantTask",
                type: "task",
                status: "completed",
                resultText: giantText,
              },
            ],
          },
        },
      };

      const presentation = getHubPresentation("hub", detail);
      expect(presentation?.blocks[0].text.length).toBe(120_000);
      expect(presentation?.blocks[0].text).toBe(giantText);
    });
  });

  describe("failure and state regressions", () => {
    it("running inbox output null does not claim Inbox empty (blocks empty)", () => {
      const detail: ToolCallDetail = {
        type: "unknown",
        input: { op: "inbox" },
        output: null,
      };
      const presentation = getHubPresentation("hub", detail);
      expect(presentation).toEqual({
        summary: "inbox",
        blocks: [],
        op: "inbox",
        status: "running",
      });
      expect(formatHubTitle(presentation, t)).toBe("Inbox");
    });

    it("failed inbox isError true text 'Hub disconnected' stays visible", () => {
      const detail: ToolCallDetail = {
        type: "unknown",
        input: { op: "inbox" },
        output: {
          isError: true,
          content: [{ type: "text", text: "Hub disconnected" }],
        },
      };
      const presentation = getHubPresentation("hub", detail);
      expect(presentation).toEqual({
        summary: "inbox",
        blocks: [
          {
            id: "hub-error",
            heading: null,
            meta: null,
            text: "Hub disconnected",
            format: "prose",
            status: "failed",
          },
        ],
        op: "inbox",
        target: undefined,
        status: "failed",
        isProcess: false,
      });
      expect(formatHubTitle(presentation, t)).toBe("Inbox");
    });

    it("running cancel ids with no output does not claim Cancelled", () => {
      const detail: ToolCallDetail = {
        type: "unknown",
        input: { op: "cancel", ids: ["bg-1", "bg-2"] },
        output: null,
      };
      const presentation = getHubPresentation("hub", detail);
      expect(presentation).toEqual({
        summary: "cancel · bg-1 · bg-2",
        blocks: [
          {
            id: "cancel",
            heading: null,
            meta: null,
            text: "",
            format: "prose",
            status: "running",
          },
        ],
        op: "cancel",
        target: "bg-1, bg-2",
        status: "running",
      });
      expect(formatHubTitle(presentation, t)).toBe("Cancelling bg-1, bg-2");
    });

    it("failed process start preserves failure not success", () => {
      const detail: ToolCallDetail = {
        type: "unknown",
        input: {
          op: "start",
          name: "web-server",
          application: "bun",
          args: ["run", "dev"],
        },
        output: {
          isError: true,
          content: [{ type: "text", text: "Failed to spawn process: ENOENT" }],
        },
      };
      const presentation = getHubPresentation("hub", detail);
      expect(presentation).toEqual({
        summary: "start · web-server",
        blocks: [
          {
            id: "hub-error",
            heading: null,
            meta: null,
            text: "Failed to spawn process: ENOENT",
            format: "prose",
            status: "failed",
          },
        ],
        op: "start",
        target: "web-server",
        status: "failed",
        isProcess: true,
      });
      expect(formatHubTitle(presentation, t)).toBe("Failed to start web-server");
    });

    it("raw logs preserve leading whitespace and trailing newline", () => {
      const rawLogs = "   [00:01] leading space\n\t[00:02] tab indented\r\n[00:03] final line\n";
      const detail: ToolCallDetail = {
        type: "unknown",
        input: {
          op: "logs",
          name: "web-server",
        },
        output: {
          content: [{ type: "text", text: rawLogs }],
          details: {
            op: "logs",
            state: "ready",
          },
        },
      };
      const presentation = getHubPresentation("hub", detail);
      expect(presentation).toEqual({
        summary: "logs · web-server",
        blocks: [
          {
            id: "logs-out",
            heading: null,
            meta: "state: ready",
            text: rawLogs,
            format: "code",
            status: "ready",
          },
        ],
        op: "logs",
        target: "web-server",
        status: "completed",
        isProcess: true,
        daemonState: "ready",
      });
      expect(presentation?.blocks[0].text).toBe(rawLogs);
      expect(presentation?.blocks[0].text.startsWith("   ")).toBe(true);
      expect(presentation?.blocks[0].text.endsWith("\n")).toBe(true);
      expect(formatHubTitle(presentation, t)).toBe("Logs from web-server");
    });
  });

  describe("formatHubTitle and preview metadata", () => {
    it("formats peer send headlines and strips internal boilerplate from preview", () => {
      const completedDetail: ToolCallDetail = {
        type: "unknown",
        input: { op: "send", to: "OverlayGuard", message: "Hello", await: false },
        output: {
          details: { op: "send", receipts: [{ to: "OverlayGuard", outcome: "injected" }] },
          content: [{ type: "text", text: "Delivered to 1 peer(s):\n- OverlayGuard: injected" }],
        },
      };
      const completed = getHubPresentation("hub", completedDetail);
      expect(formatHubTitle(completed, t)).toBe("Message sent to OverlayGuard");
      expect(completed?.blocks[0].previewHeading).toBeNull();
      expect(completed?.blocks[0].meta).toContain("await: false"); // preserved in full details!
      expect(completed?.blocks[0].previewMeta ?? "").not.toContain("await: false"); // dropped from preview!
      expect(completed?.blocks[1].omitFromPreview).toBe(true); // duplicate receipt dropped!

      const runningDetail: ToolCallDetail = {
        type: "unknown",
        input: { op: "send", to: "OverlayGuard", message: "Hello" },
        output: null,
      };
      const running = getHubPresentation("hub", runningDetail, "running");
      expect(formatHubTitle(running, t)).toBe("Sending message to OverlayGuard");

      const failedDetail: ToolCallDetail = {
        type: "unknown",
        input: { op: "send", to: "OverlayGuard", message: "Hello" },
        output: {
          isError: true,
          content: [{ type: "text", text: "Peer not found" }],
        },
      };
      const failed = getHubPresentation("hub", failedDetail);
      expect(formatHubTitle(failed, t)).toBe("Failed to send message to OverlayGuard");
    });

    it("formats process send headlines and strips pid from preview", () => {
      const detail: ToolCallDetail = {
        type: "unknown",
        input: { op: "send", name: "web-server", keys: ["CTRL_C"] },
        output: {
          details: {
            op: "send",
            daemon: { name: "web-server", state: "ready", pid: 4120 },
          },
          content: [{ type: "text", text: "Sent input to web-server: ready pid=4120" }],
        },
      };
      const presentation = getHubPresentation("hub", detail);
      expect(formatHubTitle(presentation, t)).toBe("Input sent to web-server");
      expect(presentation?.blocks[0].previewHeading).toBeNull();
      expect(presentation?.blocks[1].omitFromPreview).toBe(true);
    });

    it("formats process start, stop, restart, describe, and logs headlines", () => {
      const startPres = getHubPresentation("hub", {
        type: "unknown",
        input: { op: "start", name: "web-server", application: "bun", args: ["run", "dev"] },
        output: { details: { daemon: { name: "web-server", state: "ready", pid: 123 } } },
      });
      expect(formatHubTitle(startPres, t)).toBe("Started web-server");

      const stopPres = getHubPresentation("hub", {
        type: "unknown",
        input: { op: "stop", name: "web-server" },
        output: { content: [{ type: "text", text: "Stopped" }] },
      });
      expect(formatHubTitle(stopPres, t)).toBe("Stopped web-server");

      const restartPres = getHubPresentation("hub", {
        type: "unknown",
        input: { op: "restart", name: "web-server" },
        output: { content: [{ type: "text", text: "Restarted" }] },
      });
      expect(formatHubTitle(restartPres, t)).toBe("Restarted web-server");

      const describePres = getHubPresentation("hub", {
        type: "unknown",
        input: { op: "describe", name: "web-server" },
        output: { content: [{ type: "text", text: "Details" }] },
      });
      expect(formatHubTitle(describePres, t)).toBe("Process web-server");

      const logsPres = getHubPresentation("hub", {
        type: "unknown",
        input: { op: "logs", name: "web-server" },
        output: {
          content: [{ type: "text", text: "log lines" }],
          details: { cursor: 1042, daemon: { pid: 4120 } },
        },
      });
      expect(formatHubTitle(logsPres, t)).toBe("Logs from web-server");
      expect(logsPres?.blocks[0].previewMeta).toBeUndefined();
    });

    it("formats wait headlines and handles running wait with label equal ID", () => {
      const runningWaitDetail: ToolCallDetail = {
        type: "unknown",
        input: { op: "wait", ids: ["OverlayGuard"] },
        output: {
          details: {
            op: "wait",
            jobs: [
              {
                id: "OverlayGuard",
                label: "OverlayGuard",
                status: "running",
                durationMs: 45000,
                resolvedModel: "claude-3-5-sonnet",
                type: "task",
              },
            ],
          },
        },
      };
      const presentation = getHubPresentation("hub", runningWaitDetail, "running");
      expect(formatHubTitle(presentation, t)).toBe("Waiting for OverlayGuard");
      expect(presentation?.blocks[0].heading).toBe("OverlayGuard");
      expect(presentation?.blocks[0].isNoResultYet).toBe(true);
      expect(presentation?.blocks[0].previewMeta).toBeNull(); // duration is in block.duration!
      expect(presentation?.blocks[0].duration).toBe("45s");
      expect(presentation?.blocks[0].meta).toBe("task · running · 45s · claude-3-5-sonnet"); // preserved in full details!

      const completedWaitDetail: ToolCallDetail = {
        type: "unknown",
        input: { op: "wait", ids: ["OverlayGuard"] },
        output: {
          details: {
            op: "wait",
            jobs: [
              {
                id: "OverlayGuard",
                label: "OverlayGuard",
                status: "completed",
                durationMs: 45000,
                resultText: "Guarded successfully",
              },
            ],
          },
        },
      };
      const completedWait = getHubPresentation("hub", completedWaitDetail);
      expect(formatHubTitle(completedWait, t)).toBe("Waited for OverlayGuard");
    });

    it("formats jobs, inbox, list, ps, and cancel headlines", () => {
      const jobsPres = getHubPresentation("hub", {
        type: "unknown",
        input: { op: "jobs" },
        output: { details: { jobs: [] } },
      });
      expect(formatHubTitle(jobsPres, t)).toBe("Background jobs");

      const inboxPres = getHubPresentation("hub", {
        type: "unknown",
        input: { op: "inbox" },
        output: { details: { inbox: [] } },
      });
      expect(formatHubTitle(inboxPres, t)).toBe("Inbox");

      const inboxPeekPres = getHubPresentation("hub", {
        type: "unknown",
        input: { op: "inbox", peek: true },
        output: { details: { inbox: [] } },
      });
      expect(formatHubTitle(inboxPeekPres, t)).toBe("Inbox (peek)");

      const listPres = getHubPresentation("hub", {
        type: "unknown",
        input: { op: "list" },
        output: { details: { peers: [] } },
      });
      expect(formatHubTitle(listPres, t)).toBe("Agents");

      const listFilteredPres = getHubPresentation("hub", {
        type: "unknown",
        input: { op: "list", status: "running" },
        output: { details: { peers: [] } },
      });
      expect(formatHubTitle(listFilteredPres, t)).toBe("Agents (running)");

      const psPres = getHubPresentation("hub", {
        type: "unknown",
        input: { op: "ps" },
        output: { details: { daemons: [] } },
      });
      expect(formatHubTitle(psPres, t)).toBe("Processes");

      const cancelPres = getHubPresentation("hub", {
        type: "unknown",
        input: { op: "cancel", ids: ["Job1"] },
        output: { content: [{ type: "text", text: "Cancelled" }] },
      });
      expect(formatHubTitle(cancelPres, t)).toBe("Cancelled Job1");
    });
  });
});
