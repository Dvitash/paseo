import { describe, expect, it } from "vitest";
import {
  computeNotificationPlan,
  isPushEligibleAttentionReason,
  type ClientPresenceState,
  PRESENCE_THRESHOLD_MS,
} from "./agent-attention-policy.js";

function state(overrides: Partial<ClientPresenceState>): ClientPresenceState {
  return {
    appVisible: true,
    isMobile: false,
    focusedAgentId: null,
    focusedTerminalId: null,
    lastActivityAtMs: null,
    lastAppActivityAtMs: overrides.lastAppActivityAtMs ?? overrides.lastActivityAtMs ?? null,
    ...overrides,
  };
}

describe("computeNotificationPlan", () => {
  const nowMs = Date.parse("2026-04-19T12:00:00.000Z");
  const staleAtMs = nowMs - PRESENCE_THRESHOLD_MS - 1;
  const presentAtMs = nowMs - PRESENCE_THRESHOLD_MS + 1;

  it("does not suppress notifications when a focused client is stale", () => {
    const staleFocused = state({
      focusedAgentId: "agent-1",
      lastActivityAtMs: staleAtMs,
    });

    expect(
      computeNotificationPlan({
        allStates: [staleFocused],
        focusTarget: { kind: "agent", id: "agent-1" },
        pushEligible: true,
        mobilePushOverride: false,
        nowMs,
      }),
    ).toEqual({ inAppRecipientIndex: null, pushScope: "all" });
  });

  it("suppresses notifications when a focused desktop client is present and interacted", () => {
    const staleFocused = state({
      focusedAgentId: "agent-1",
      lastActivityAtMs: staleAtMs,
    });
    const presentFocused = state({
      focusedAgentId: "agent-1",
      lastActivityAtMs: presentAtMs,
    });

    expect(
      computeNotificationPlan({
        allStates: [staleFocused, presentFocused],
        focusTarget: { kind: "agent", id: "agent-1" },
        pushEligible: true,
        mobilePushOverride: false,
        nowMs,
      }),
    ).toEqual({ inAppRecipientIndex: null, pushScope: null });
  });

  it("pushes to mobile when a focused desktop client is present and override applies", () => {
    const presentFocused = state({
      focusedAgentId: "agent-1",
      lastActivityAtMs: presentAtMs,
    });

    expect(
      computeNotificationPlan({
        allStates: [presentFocused],
        focusTarget: { kind: "agent", id: "agent-1" },
        pushEligible: true,
        mobilePushOverride: true,
        nowMs,
      }),
    ).toEqual({ inAppRecipientIndex: null, pushScope: "mobile" });
  });

  it("suppresses everything when a focused mobile client is present", () => {
    const presentFocusedMobile = state({
      isMobile: true,
      focusedAgentId: "agent-1",
      lastActivityAtMs: presentAtMs,
    });

    expect(
      computeNotificationPlan({
        allStates: [presentFocusedMobile],
        focusTarget: { kind: "agent", id: "agent-1" },
        pushEligible: true,
        mobilePushOverride: true,
        nowMs,
      }),
    ).toEqual({ inAppRecipientIndex: null, pushScope: null });
  });

  it("does not suppress notifications when a focused client is backgrounded", () => {
    const backgroundFocused = state({
      appVisible: false,
      focusedAgentId: "agent-1",
      lastActivityAtMs: presentAtMs,
    });

    expect(
      computeNotificationPlan({
        allStates: [backgroundFocused],
        focusTarget: { kind: "agent", id: "agent-1" },
        pushEligible: true,
        mobilePushOverride: false,
        nowMs,
      }),
    ).toEqual({ inAppRecipientIndex: 0, pushScope: null });
  });

  it("pushes to mobile when a focused desktop client is visible but has stale app interaction", () => {
    const staleFocused = state({
      focusedAgentId: "agent-1",
      // Presence fresh via OS-idle, but the app window itself is untouched.
      lastActivityAtMs: presentAtMs,
      lastAppActivityAtMs: staleAtMs,
    });

    expect(
      computeNotificationPlan({
        allStates: [staleFocused],
        focusTarget: { kind: "agent", id: "agent-1" },
        pushEligible: true,
        mobilePushOverride: false,
        nowMs,
      }),
    ).toEqual({ inAppRecipientIndex: 0, pushScope: "mobile" });
  });

  it("chooses the present client with the greatest clamped activity timestamp", () => {
    expect(
      computeNotificationPlan({
        allStates: [
          state({ lastActivityAtMs: nowMs - 10_000 }),
          state({ lastActivityAtMs: nowMs - 1_000 }),
          state({ lastActivityAtMs: staleAtMs }),
        ],
        focusTarget: { kind: "agent", id: "agent-1" },
        pushEligible: true,
        mobilePushOverride: false,
        nowMs,
      }),
    ).toEqual({ inAppRecipientIndex: 1, pushScope: null });
  });

  it("uses the lower index when present clients have identical timestamps", () => {
    expect(
      computeNotificationPlan({
        allStates: [
          state({ lastActivityAtMs: nowMs - 1_000 }),
          state({ lastActivityAtMs: nowMs - 1_000 }),
        ],
        focusTarget: { kind: "agent", id: "agent-1" },
        pushEligible: true,
        mobilePushOverride: false,
        nowMs,
      }),
    ).toEqual({ inAppRecipientIndex: 0, pushScope: null });
  });

  it("clamps future timestamps to now and treats them as present", () => {
    expect(
      computeNotificationPlan({
        allStates: [
          state({ lastActivityAtMs: nowMs - 1 }),
          state({ lastActivityAtMs: nowMs + 600_000 }),
        ],
        focusTarget: { kind: "agent", id: "agent-1" },
        pushEligible: true,
        mobilePushOverride: false,
        nowMs,
      }),
    ).toEqual({ inAppRecipientIndex: 1, pushScope: null });
  });

  it("never treats no-heartbeat clients as present", () => {
    expect(
      computeNotificationPlan({
        allStates: [state({ lastActivityAtMs: null })],
        focusTarget: { kind: "agent", id: "agent-1" },
        pushEligible: true,
        mobilePushOverride: false,
        nowMs,
      }),
    ).toEqual({ inAppRecipientIndex: null, pushScope: "all" });
  });

  it("falls back to push for non-error attention when no clients are present", () => {
    expect(
      computeNotificationPlan({
        allStates: [state({ lastActivityAtMs: staleAtMs })],
        focusTarget: { kind: "agent", id: "agent-1" },
        pushEligible: true,
        mobilePushOverride: false,
        nowMs,
      }),
    ).toEqual({ inAppRecipientIndex: null, pushScope: "all" });
  });

  it("does not push error attention when no clients are present", () => {
    expect(
      computeNotificationPlan({
        allStates: [state({ lastActivityAtMs: staleAtMs })],
        focusTarget: { kind: "agent", id: "agent-1" },
        pushEligible: false,
        mobilePushOverride: true,
        nowMs,
      }),
    ).toEqual({ inAppRecipientIndex: null, pushScope: null });
  });

  it("pushes mobile scope when presence is fresh but desktop app interaction is stale", () => {
    // Electron-style client: OS activity keeps presence fresh while the app
    // window itself has not been touched — mobile push must still fire.
    expect(
      computeNotificationPlan({
        allStates: [
          state({
            lastActivityAtMs: nowMs - 1_000,
            lastAppActivityAtMs: staleAtMs,
          }),
        ],
        focusTarget: { kind: "agent", id: "agent-1" },
        pushEligible: true,
        mobilePushOverride: false,
        nowMs,
      }),
    ).toEqual({ inAppRecipientIndex: 0, pushScope: "mobile" });
  });

  it("pushes mobile scope when override applies and a desktop client interacted recently", () => {
    expect(
      computeNotificationPlan({
        allStates: [state({ lastActivityAtMs: nowMs - 1_000 })],
        focusTarget: { kind: "agent", id: "agent-1" },
        pushEligible: true,
        mobilePushOverride: true,
        nowMs,
      }),
    ).toEqual({ inAppRecipientIndex: 0, pushScope: "mobile" });
  });

  it("does not suppress push when a mobile client interacted recently", () => {
    // Mobile interaction alone never blocks push — the phone may be backgrounded.
    expect(
      computeNotificationPlan({
        allStates: [state({ isMobile: true, appVisible: false, lastActivityAtMs: nowMs - 1_000 })],
        focusTarget: { kind: "agent", id: "agent-1" },
        pushEligible: true,
        mobilePushOverride: false,
        nowMs,
      }),
    ).toEqual({ inAppRecipientIndex: 0, pushScope: "mobile" });
  });

  it("selects no in-app recipient and pushes all when two web-style clients are stale", () => {
    expect(
      computeNotificationPlan({
        allStates: [state({ lastActivityAtMs: staleAtMs }), state({ lastActivityAtMs: staleAtMs })],
        focusTarget: { kind: "agent", id: "agent-1" },
        pushEligible: true,
        mobilePushOverride: false,
        nowMs,
      }),
    ).toEqual({ inAppRecipientIndex: null, pushScope: "all" });
  });

  it("never suppresses when focusTarget is null even if a client focuses a matching id", () => {
    expect(
      computeNotificationPlan({
        allStates: [state({ focusedTerminalId: "terminal-1", lastActivityAtMs: nowMs - 500 })],
        focusTarget: null,
        pushEligible: true,
        mobilePushOverride: false,
        nowMs,
      }),
    ).toEqual({ inAppRecipientIndex: 0, pushScope: null });
  });

  it("suppresses terminal notifications when a present visible client focuses the terminal", () => {
    expect(
      computeNotificationPlan({
        allStates: [state({ focusedTerminalId: "terminal-1", lastActivityAtMs: nowMs - 500 })],
        focusTarget: { kind: "terminal", id: "terminal-1" },
        pushEligible: true,
        mobilePushOverride: false,
        nowMs,
      }),
    ).toEqual({ inAppRecipientIndex: null, pushScope: null });
  });

  it("pushes for a null-focus target when no client is present and push is eligible", () => {
    expect(
      computeNotificationPlan({
        allStates: [state({ lastActivityAtMs: staleAtMs })],
        focusTarget: null,
        pushEligible: true,
        mobilePushOverride: false,
        nowMs,
      }),
    ).toEqual({ inAppRecipientIndex: null, pushScope: "all" });
  });
});

describe("isPushEligibleAttentionReason", () => {
  it("allows push for finished and permission but not error", () => {
    expect(isPushEligibleAttentionReason("finished")).toBe(true);
    expect(isPushEligibleAttentionReason("permission")).toBe(true);
    expect(isPushEligibleAttentionReason("error")).toBe(false);
  });
});
