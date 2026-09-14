import { expect, test } from "vitest";
import { createViewedTimelineSync } from "@/timeline/viewed-timeline-sync";
import { createForegroundTimelineRecovery } from "./foreground-timeline-recovery";

async function settle() {
  for (let step = 0; step < 30; step += 1) await Promise.resolve();
}

test("a surviving PWA connection re-acknowledges membership and fetches its visible timeline", async () => {
  const subscriptions: string[][] = [];
  const fetchedAgents: string[] = [];
  const errors: unknown[] = [];
  const sync = createViewedTimelineSync({
    initialDeliveryMode: "selective",
    prepare: async () => undefined,
    replaceDemandedAgentIds: () => undefined,
    setSubscription: async (agentIds) => {
      subscriptions.push([...agentIds]);
    },
    readCursor: () => undefined,
    fetchPage: async (agentId) => {
      fetchedAgents.push(agentId);
      return { hasNewer: false, endCursor: null };
    },
    fetchLatestTail: async () => ({ hasNewer: false, endCursor: null }),
    reportError: (error) => {
      errors.push(error);
    },
    schedule: () => () => undefined,
    releaseTranscript: () => false,
  });
  const foreground = createForegroundTimelineRecovery({
    verifyConnection: async () => true,
    synchronize: () => {
      sync.setConnected(false);
      sync.setActive(true);
      sync.setConnected(true);
    },
    setActive: (active) => sync.setActive(active),
    schedule: () => () => undefined,
    reportError: (error) => {
      errors.push(error);
    },
  });

  sync.setConnected(true);
  sync.replaceVisibleAgentIds("pwa-pane", ["agent-a"]);
  await settle();
  expect(fetchedAgents).toEqual(["agent-a"]);

  // No hidden render and no connection-state transition: the resume edge alone
  // must revalidate the content that was already on screen.
  foreground.resume();
  await settle();
  expect(subscriptions).toEqual([["agent-a"], ["agent-a"]]);
  expect(fetchedAgents).toEqual(["agent-a", "agent-a"]);
  expect(errors).toEqual([]);
  foreground.dispose();
  sync.dispose();
});
