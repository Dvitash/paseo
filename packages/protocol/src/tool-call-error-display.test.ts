import { describe, expect, it } from "vitest";
import { buildToolCallDisplayModel } from "./tool-call-display.js";

const message = "Daemon broker request aborted";
const envelope = { content: [{ type: "text", text: message }], details: {} };

function errorText(error: unknown) {
  return buildToolCallDisplayModel({
    name: "hub",
    status: "failed",
    error,
    detail: { type: "unknown", input: null, output: null },
  }).errorText;
}

describe("tool-call error display", () => {
  it.each([
    envelope,
    JSON.stringify(envelope),
    { content: envelope.content },
    { ...envelope, isError: true },
    { content: message },
  ])("unwraps a text-only error envelope: %j", (error) => {
    expect(errorText(error)).toBe(message);
  });

  it("preserves plain text and line breaks", () => {
    expect(errorText(`${message}\nPlease retry.`)).toBe(`${message}\nPlease retry.`);
  });

  it("retains every text block in order", () => {
    expect(
      errorText({
        content: [
          { type: "text", text: message },
          { type: "text", text: "Connection closed.\nPlease retry." },
        ],
        details: null,
      }),
    ).toBe(`${message}\nConnection closed.\nPlease retry.`);
  });

  it.each([
    { ...envelope, details: { code: "ABORTED", requestId: "request-1" } },
    { ...envelope, stack: "Error: aborted\n  at broker.ts:42" },
    { content: message, details: { code: "ABORTED" } },
    { content: [...envelope.content, { type: "resource", resource: { uri: "file:///log" } }] },
    { content: [{ type: "text", text: message, annotations: { priority: 1 } }] },
    { content: [{ type: "text", text: "" }], details: {} },
    { content: [{ type: "text", text: 42 }] },
    { content: [], details: {} },
    { message: "Unknown error shape", code: 500 },
  ])("preserves diagnostics and unfamiliar payloads: %j", (error) => {
    expect(errorText(error)).toBe(JSON.stringify(error, null, 2));
  });

  it("leaves unrecognized and malformed JSON strings intact", () => {
    const diagnostic = JSON.stringify({ ...envelope, details: { code: "ABORTED" } });
    expect(errorText(diagnostic)).toBe(diagnostic);
    expect(errorText('{"content": [')).toBe('{"content": [');
  });

  it.each([null, undefined])("omits a missing error: %s", (error) => {
    expect(errorText(error)).toBeUndefined();
  });

  it.each(["running", "completed", "canceled"] as const)(
    "does not display stale error data for a %s call",
    (status) => {
      expect(
        buildToolCallDisplayModel({
          name: "hub",
          status,
          error: envelope,
          detail: { type: "unknown", input: null, output: null },
        }).errorText,
      ).toBeUndefined();
    },
  );
});
