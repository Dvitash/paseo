import { describe, expect, it } from "vitest";
import { buildToolCallPresentation } from "./presentation";

const message = "Daemon broker request aborted";
const envelope = { content: [{ type: "text", text: message }], details: {} };

function resolveIcon() {
  return () => null;
}

function failedHub(error: unknown, output: unknown = envelope) {
  return buildToolCallPresentation({
    toolName: "hub",
    status: "failed",
    error,
    detail: {
      type: "unknown",
      input: { op: "wait", name: "terra-usable-tool-canary", for: "exit" },
      output,
    },
    resolveIcon,
  });
}

describe("failed Hub error presentation", () => {
  it.each([envelope, JSON.stringify(envelope), message])(
    "renders an error once instead of appending a duplicate: %j",
    (error) => {
      const presentation = failedHub(error);
      expect(presentation.errorText).toBeUndefined();
      expect(presentation.hasPreview).toBe(true);
      expect(presentation.hasDetails).toBe(true);
      expect(presentation.canOpenDetails).toBe(true);
      expect(presentation.hub?.blocks).toEqual([
        {
          id: "hub-error",
          heading: null,
          meta: null,
          text: message,
          format: "prose",
          status: "failed",
        },
      ]);
    },
  );

  it("does not discard an error that differs from the output", () => {
    const presentation = failedHub("Transport disconnected");
    expect(presentation.errorText).toBe("Transport disconnected");
    expect(presentation.hub?.blocks[0].text).toBe(message);
  });

  it("keeps nonempty diagnostic metadata even when the message matches", () => {
    const error = { ...envelope, details: { code: "ABORTED", requestId: "request-1" } };
    expect(failedHub(error).errorText).toBe(JSON.stringify(error, null, 2));
  });

  it("keeps the only error when no tool output is available", () => {
    const presentation = failedHub(envelope, null);
    expect(presentation.errorText).toBe(message);
    expect(presentation.canOpenDetails).toBe(true);
  });

  it("keeps long errors in Hub so its preview truncation can expose the full message", () => {
    const text = `${message}\n${"diagnostic line\n".repeat(50)}`;
    const error = { content: [{ type: "text", text }], details: {} };
    const presentation = failedHub(error, error);
    expect(presentation.errorText).toBeUndefined();
    expect(presentation.hub?.blocks[0].text.trim()).toBe(text.trim());
    expect(presentation.canOpenDetails).toBe(true);
  });

  it("does not suppress a non-Hub failure", () => {
    const presentation = buildToolCallPresentation({
      toolName: "custom_tool",
      status: "failed",
      error: envelope,
      detail: { type: "unknown", input: {}, output: envelope },
      resolveIcon,
    });
    expect(presentation.hub).toBeNull();
    expect(presentation.errorText).toBe(message);
  });
});
