import { queryClient as appQueryClient } from "@/data/query-client";
import { getDesktopHost } from "@/desktop/host";
import { getIsElectron, isNative } from "@/constants/platform";
import { APP_SETTINGS_QUERY_KEY, normalizeAppSettings } from "@/hooks/use-settings/storage";

export type AgentAttentionAlertReason = "finished" | "permission";

/**
 * Title shown while flashing. Matches the English-only titles produced by
 * `buildAgentAttentionNotificationPayload` for OS notifications.
 */
export const ATTENTION_ALERT_TITLE = "● Agent needs input";

// ---------------------------------------------------------------------------
// App badge (installed PWA taskbar/dock icon)
// ---------------------------------------------------------------------------

/**
 * Mirrors the Electron dock badge for installed PWAs: Chromium surfaces
 * `setAppBadge` on the taskbar/dock icon. No-ops where the API is missing.
 */
export async function updateWebAppBadge(count: number | undefined): Promise<void> {
  // Electron sets its badge through the window bridge, not this API.
  if (isNative || getIsElectron() || typeof navigator === "undefined") {
    return;
  }
  try {
    if (typeof count === "number" && count > 0 && typeof navigator.setAppBadge === "function") {
      await navigator.setAppBadge(count);
    } else if (typeof navigator.clearAppBadge === "function") {
      await navigator.clearAppBadge();
    }
  } catch {
    // setAppBadge rejects on some platforms when the app isn't installed.
  }
}

// ---------------------------------------------------------------------------
// Document title flash
// ---------------------------------------------------------------------------

const TITLE_FLASH_INTERVAL_MS = 1000;

let titleFlashText = "";
let titleFlashTimer: ReturnType<typeof setInterval> | null = null;
let titleFlashShowingAlert = false;
let baseTitle = "";
/** The title this module last wrote — observer callbacks compare against it, not the alert text. */
let lastWrittenTitle = "";
let titleObserver: MutationObserver | null = null;

/**
 * The workspace screen owns document.title and can rewrite it mid-flash. Track
 * external writes through the <title> element so the flash restores the newest
 * base title instead of whatever was current when the alert started.
 */
function ensureTitleObserver(): void {
  if (titleObserver || typeof MutationObserver !== "function") {
    return;
  }
  const titleElement = document.querySelector("title");
  if (!titleElement) {
    return;
  }
  titleObserver = new MutationObserver(() => {
    if (document.title !== lastWrittenTitle) {
      baseTitle = document.title;
    }
  });
  titleObserver.observe(titleElement, { childList: true, characterData: true, subtree: true });
}

function stopTitleFlash(): void {
  if (titleFlashTimer !== null) {
    clearInterval(titleFlashTimer);
    titleFlashTimer = null;
  }
  if (titleFlashShowingAlert) {
    titleFlashShowingAlert = false;
    document.title = baseTitle;
    lastWrittenTitle = baseTitle;
  }
}

function startTitleFlash(): void {
  if (titleFlashTimer !== null) {
    return;
  }
  baseTitle = document.title;
  titleFlashShowingAlert = true;
  document.title = titleFlashText;
  lastWrittenTitle = titleFlashText;
  titleFlashTimer = setInterval(() => {
    titleFlashShowingAlert = !titleFlashShowingAlert;
    const next = titleFlashShowingAlert ? titleFlashText : baseTitle;
    document.title = next;
    lastWrittenTitle = next;
  }, TITLE_FLASH_INTERVAL_MS);
}

/**
 * Drives the flashing document title. Flashes while `active` and the window is
 * unfocused; restores the base title on focus, when the alert clears, or when
 * the setting turns it off.
 */
export function setDocumentTitleAlert(input: {
  active: boolean;
  text: string;
  focused: boolean;
}): void {
  if (isNative || typeof document === "undefined") {
    return;
  }
  titleFlashText = input.text;

  if (!input.active || input.focused || input.text.length === 0) {
    stopTitleFlash();
    return;
  }
  ensureTitleObserver();
  startTitleFlash();
}

// ---------------------------------------------------------------------------
// Notification sound (web/PWA — Electron uses the OS notification sound)
// ---------------------------------------------------------------------------

interface AttentionAudioContext {
  currentTime: number;
  state?: string;
  destination: unknown;
  resume?: () => Promise<void>;
  createOscillator: () => {
    type: string;
    frequency: { setValueAtTime: (value: number, time: number) => void };
    connect: (node: unknown) => void;
    start: (time: number) => void;
    stop: (time: number) => void;
  };
  createGain: () => {
    gain: {
      setValueAtTime: (value: number, time: number) => void;
      exponentialRampToValueAtTime: (value: number, time: number) => void;
    };
    connect: (node: unknown) => void;
  };
}

let attentionAudioContext: AttentionAudioContext | null = null;

function getAttentionAudioContext(): AttentionAudioContext | null {
  if (attentionAudioContext) {
    return attentionAudioContext;
  }
  // webkitAudioContext is the pre-standard Safari name; lib.dom only types AudioContext.
  const scope = globalThis as {
    AudioContext?: new () => AttentionAudioContext;
    webkitAudioContext?: new () => AttentionAudioContext;
  };
  const AudioContextConstructor = scope.AudioContext ?? scope.webkitAudioContext;
  if (!AudioContextConstructor) {
    return null;
  }
  try {
    attentionAudioContext = new AudioContextConstructor();
  } catch {
    return null;
  }
  return attentionAudioContext;
}

// Autoplay policy suspends an AudioContext created before the first user
// gesture. Warm it on the first pointerdown/keydown so the first real
// notification isn't silent. Listeners self-remove once the context runs.
if (!isNative && typeof window !== "undefined") {
  const unlockAudio = () => {
    const context = getAttentionAudioContext();
    if (!context || context.state === "running") {
      window.removeEventListener("pointerdown", unlockAudio);
      window.removeEventListener("keydown", unlockAudio);
      return;
    }
    context.resume?.().catch(() => undefined);
  };
  window.addEventListener("pointerdown", unlockAudio);
  window.addEventListener("keydown", unlockAudio);
}

interface ChimeNote {
  frequency: number;
  offset: number;
  duration: number;
}

const FINISHED_CHIME: ChimeNote[] = [
  { frequency: 880, offset: 0, duration: 0.18 },
  { frequency: 1174.66, offset: 0.12, duration: 0.32 },
];

const PERMISSION_CHIME: ChimeNote[] = [
  { frequency: 987.77, offset: 0, duration: 0.14 },
  { frequency: 987.77, offset: 0.18, duration: 0.14 },
  { frequency: 1318.51, offset: 0.36, duration: 0.3 },
];

function playChime(notes: ChimeNote[]): void {
  const context = getAttentionAudioContext();
  if (!context) {
    return;
  }
  // A suspended context still queues scheduled notes — they play once the
  // unlock listener above (or this resume) starts the clock.
  if (context.state === "suspended" && typeof context.resume === "function") {
    void context.resume().catch(() => undefined);
  }
  const startAt = context.currentTime + 0.02;
  for (const note of notes) {
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(note.frequency, startAt + note.offset);
    gain.gain.setValueAtTime(0.0001, startAt + note.offset);
    gain.gain.exponentialRampToValueAtTime(0.18, startAt + note.offset + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, startAt + note.offset + note.duration);
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start(startAt + note.offset);
    oscillator.stop(startAt + note.offset + note.duration + 0.05);
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function readNotificationSetting(key: "notificationSounds" | "notificationFlash"): boolean {
  return normalizeAppSettings(appQueryClient.getQueryData(APP_SETTINGS_QUERY_KEY))[key];
}

async function requestDesktopWindowAttention(): Promise<void> {
  const desktopWindow = getDesktopHost()?.window?.getCurrentWindow?.();
  if (!desktopWindow || typeof desktopWindow.requestAttention !== "function") {
    return;
  }
  try {
    await desktopWindow.requestAttention();
  } catch (error) {
    console.warn("[attention-alerts] Failed to request window attention", error);
  }
}

/**
 * Fires the per-event attention side effects that OS notifications don't cover:
 * an in-app chime on web/PWA (browser notifications are silent there) and a
 * taskbar flash/dock bounce on the desktop app. The persistent app badge and
 * title flash are state-driven in useFaviconStatus, not here.
 */
export function signalAgentAttentionAlert(reason: AgentAttentionAlertReason): void {
  if (isNative) {
    return;
  }

  if (readNotificationSetting("notificationSounds") && !getIsElectron()) {
    playChime(reason === "permission" ? PERMISSION_CHIME : FINISHED_CHIME);
  }

  if (reason === "permission" && readNotificationSetting("notificationFlash")) {
    void requestDesktopWindowAttention();
  }
}
