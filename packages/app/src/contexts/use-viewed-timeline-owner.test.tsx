/**
 * @vitest-environment jsdom
 */
import { act } from "react";
import { renderHook } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { useViewedTimelineOwner } from "./use-viewed-timeline-owner";
import { HostRuntimeStore } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { defaultHostAppearance } from "@/hosts/appearance";
import type { ConnectionState, DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { HostProfile } from "@/types/host-connection";

const HOST_SERVER_ID = "srv_owner_replacement";
const STORE_GLOBAL_KEY = "__paseoHostRuntimeStore";

/**
 * Minimal DaemonClient surface for this test: the owner ports (server info +
 * subscription RPC), the directory's timeline fetch, and the controller's probe
 * path. Everything else stays unused.
 */
class OwnerTestClient {
  readonly subscriptionRequests: string[][] = [];
  private listeners = new Set<(status: ConnectionState) => void>();
  private state: ConnectionState = { status: "connected" };

  getLastServerInfoMessage(): { features: { selectiveAgentTimeline: boolean } } {
    return { features: { selectiveAgentTimeline: true } };
  }

  async setAgentTimelineSubscription(agentIds: string[]): Promise<void> {
    this.subscriptionRequests.push([...agentIds]);
  }

  async fetchAgentTimeline(): Promise<Awaited<ReturnType<DaemonClient["fetchAgentTimeline"]>>> {
    return makeTailPage();
  }

  async connect(): Promise<void> {
    this.setConnectionState({ status: "connected" });
  }

  async close(): Promise<void> {
    this.setConnectionState({ status: "disconnected", reason: "client_closed" });
  }

  setReconnectEnabled(): void {}

  subscribeConnectionStatus(listener: (status: ConnectionState) => void): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => {
      this.listeners.delete(listener);
    };
  }

  get lastError(): string | null {
    return null;
  }

  getLastLivenessRttMs(): number | null {
    return 1;
  }

  async measureLatency(): Promise<number> {
    return 1;
  }

  on(): () => void {
    return () => undefined;
  }

  setConnectionState(next: ConnectionState): void {
    this.state = next;
    for (const listener of this.listeners) listener(next);
  }
}

function makeTailPage(): Awaited<ReturnType<DaemonClient["fetchAgentTimeline"]>> {
  return {
    direction: "tail",
    projection: "projected",
    epoch: "epoch-1",
    seqStart: 1,
    seqEnd: 1,
    sourceSeqRanges: [],
    collapsed: [],
    items: [],
    hasOlder: false,
    hasNewer: false,
    hasMore: false,
  } as unknown as Awaited<ReturnType<DaemonClient["fetchAgentTimeline"]>>;
}

function makeHostProfile(): HostProfile {
  const direct = { id: "direct:lan:6767", type: "directTcp" as const, endpoint: "lan:6767" };
  return {
    serverId: HOST_SERVER_ID,
    label: "owner test host",
    appearance: defaultHostAppearance(),
    lifecycle: {},
    connections: [direct],
    preferredConnectionId: direct.id,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  };
}

function seedHostRuntimeStore(): HostRuntimeStore {
  const storeClient = new OwnerTestClient();
  const store = new HostRuntimeStore({
    deps: {
      createClient: () => storeClient as unknown as DaemonClient,
      connectToDaemon: async ({ host }) => ({
        client: storeClient as unknown as DaemonClient,
        serverId: host.serverId,
        hostname: null,
      }),
      getClientId: async () => "cid_owner_test",
    },
  });
  Reflect.set(globalThis, STORE_GLOBAL_KEY, store);
  store.syncHosts([makeHostProfile()]);
  return store;
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, STORE_GLOBAL_KEY);
  useSessionStore.getState().clearSession(HOST_SERVER_ID);
});

test("an owner created while already online connects and synchronizes without a status change", async () => {
  seedHostRuntimeStore();
  const firstClient = new OwnerTestClient();
  const secondClient = new OwnerTestClient();

  const { result, rerender } = renderHook(
    ({ client, isConnected }: { client: DaemonClient; isConnected: boolean }) =>
      useViewedTimelineOwner({ serverId: HOST_SERVER_ID, client, isConnected }),
    { initialProps: { client: firstClient as unknown as DaemonClient, isConnected: true } },
  );

  const firstOwner = result.current.viewedTimelineSyncRef.current;
  expect(firstOwner).not.toBeNull();

  act(() => {
    firstOwner?.replaceVisibleAgentIds("pane", ["agent-a"]);
  });
  await vi.waitFor(() => expect(firstClient.subscriptionRequests).toHaveLength(1));
  expect(firstClient.subscriptionRequests[0]).toEqual(["agent-a"]);

  // Replace the client while the rendered connection state stays online: the swap is
  // the only signal the new owner gets, so it must inherit the connected state at
  // creation instead of waiting for a connectionStatus change that never comes.
  rerender({ client: secondClient as unknown as DaemonClient, isConnected: true });

  const secondOwner = result.current.viewedTimelineSyncRef.current;
  expect(secondOwner).not.toBeNull();
  expect(secondOwner).not.toBe(firstOwner);

  act(() => {
    secondOwner?.replaceVisibleAgentIds("pane", ["agent-a"]);
  });

  await vi.waitFor(() => expect(secondClient.subscriptionRequests).toHaveLength(1));
  expect(secondClient.subscriptionRequests[0]).toEqual(["agent-a"]);
  expect(firstClient.subscriptionRequests).toHaveLength(1);
});
