import { expect, test } from "vitest";
import { DaemonClient } from "./daemon-client.js";

test("saved-only reads fail closed without the host capability instead of falling back to runtime history", async () => {
  const client = new DaemonClient({ url: "ws://127.0.0.1:1", clientId: "saved-history-test" });
  await expect(client.fetchAgentTimeline("archived", { savedOnly: true })).rejects.toThrow(
    "Update the host",
  );
  await expect(client.buildAgentForkContext("archived", { savedOnly: true })).rejects.toThrow(
    "Update the host",
  );
});
