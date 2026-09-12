import type { AgentAttentionReason } from "@getpaseo/protocol/agent-attention-notification";

export const PRESENCE_THRESHOLD_MS = 180_000;

export interface ClientPresenceState {
  appVisible: boolean;
  /**
   * Presence clock: may include OS-level activity (Electron reports system idle
   * time so a backgrounded desktop window still counts as present). Drives
   * in-app notification routing only.
   */
  lastActivityAtMs: number | null;
  /**
   * Interaction clock: only advances on real input inside the app window.
   * Drives push suppression — a machine in use with the app untouched does not
   * block mobile push.
   */
  lastAppActivityAtMs: number | null;
  /** Native mobile app or mobile-browser client (phone/tablet PWA). */
  isMobile: boolean;
  focusedAgentId: string | null;
  focusedTerminalId: string | null;
}

export type AttentionFocusTarget = { kind: "agent"; id: string } | { kind: "terminal"; id: string };

export type PushScope = "all" | "mobile";

export interface NotificationPlan {
  /** The single most-recently-active present client, or null. */
  inAppRecipientIndex: number | null;
  /** null = no push; "all" = every subscription; "mobile" = mobile endpoints only. */
  pushScope: PushScope | null;
}

interface ComputeNotificationPlanInput {
  allStates: ClientPresenceState[];
  // A present, app-visible client focused on the attention target suppresses the
  // notification entirely. Pass null when the target should not suppress notifications.
  focusTarget: AttentionFocusTarget | null;
  // Whether a push notification is allowed at all.
  pushEligible: boolean;
  // Push to mobile endpoints even while a desktop client shows recent app
  // interaction (permission prompts and mobile-origin agents).
  mobilePushOverride: boolean;
  nowMs: number;
}

function isFocusedOnTarget(
  state: ClientPresenceState,
  target: AttentionFocusTarget | null,
): boolean {
  if (target === null) {
    return false;
  }
  if (target.kind === "agent") {
    return state.focusedAgentId === target.id;
  }
  return state.focusedTerminalId === target.id;
}

function isRecent(atMs: number | null, nowMs: number): boolean {
  // Clamp future timestamps to now so clock skew cannot extend presence.
  return atMs !== null && nowMs - Math.min(atMs, nowMs) <= PRESENCE_THRESHOLD_MS;
}

export function computeNotificationPlan({
  allStates,
  focusTarget,
  pushEligible,
  mobilePushOverride,
  nowMs,
}: ComputeNotificationPlanInput): NotificationPlan {
  let mostRecentPresentIndex: number | null = null;
  let mostRecentPresentAtMs = Number.NEGATIVE_INFINITY;
  let anyPresent = false;
  let anyRecentDesktopAppInteraction = false;
  let activeViewer: "mobile" | "desktop" | null = null;

  for (const [clientIndex, state] of allStates.entries()) {
    const clampedActivityAtMs =
      state.lastActivityAtMs === null ? null : Math.min(state.lastActivityAtMs, nowMs);
    if (!isRecent(clampedActivityAtMs, nowMs)) {
      continue;
    }
    anyPresent = true;

    const hasRecentAppInteraction = isRecent(state.lastAppActivityAtMs, nowMs);

    // "Watching" requires real recent interaction with the app window — a
    // visible-but-untouched desktop window (OS-idle presence) does not count.
    if (state.appVisible && hasRecentAppInteraction && isFocusedOnTarget(state, focusTarget)) {
      if (state.isMobile) {
        activeViewer = "mobile";
      } else {
        activeViewer ??= "desktop";
      }
      continue;
    }

    if (!state.isMobile && hasRecentAppInteraction) {
      anyRecentDesktopAppInteraction = true;
    }

    if (clampedActivityAtMs! > mostRecentPresentAtMs) {
      mostRecentPresentIndex = clientIndex;
      mostRecentPresentAtMs = clampedActivityAtMs!;
    }
  }

  // The user is actively watching the target on a mobile device — nothing to deliver.
  if (activeViewer === "mobile") {
    return { inAppRecipientIndex: null, pushScope: null };
  }

  let pushScope: PushScope | null = null;
  if (pushEligible) {
    if (!anyPresent) {
      pushScope = "all";
    } else if (activeViewer === "desktop" || anyRecentDesktopAppInteraction) {
      // Desktop is in use: only the mobile override still pushes.
      pushScope = mobilePushOverride ? "mobile" : null;
    } else {
      // Clients are present but no desktop app interaction — push mobile only
      // so desktop-browser subscriptions don't duplicate the in-app delivery.
      pushScope = "mobile";
    }
  }

  return { inAppRecipientIndex: mostRecentPresentIndex, pushScope };
}

export function isPushEligibleAttentionReason(reason: AgentAttentionReason): boolean {
  return reason !== "error";
}
