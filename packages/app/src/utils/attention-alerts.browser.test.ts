import { afterEach, describe, expect, it, vi } from "vitest";
import { queryClient as appQueryClient } from "@/data/query-client";
import { APP_SETTINGS_QUERY_KEY } from "@/hooks/use-settings/storage";
import {
  ATTENTION_ALERT_TITLE,
  setDocumentTitleAlert,
  signalAgentAttentionAlert,
  updateWebAppBadge,
} from "./attention-alerts";

const createdOscillatorStarts: number[] = [];

class FakeOscillator {
  type = "";
  frequency = { setValueAtTime: vi.fn() };
  connect = vi.fn();
  start = vi.fn((time: number) => {
    createdOscillatorStarts.push(time);
  });
  stop = vi.fn();
}

class FakeGain {
  gain = {
    setValueAtTime: vi.fn(),
    exponentialRampToValueAtTime: vi.fn(),
  };
  connect = vi.fn();
}

class FakeAudioContext {
  currentTime = 0;
  state = "running";
  destination = {};
  createOscillator() {
    return new FakeOscillator();
  }
  createGain() {
    return new FakeGain();
  }
}

afterEach(() => {
  setDocumentTitleAlert({ active: false, text: "", focused: true });
  document.title = "";
  createdOscillatorStarts.length = 0;
  appQueryClient.clear();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("setDocumentTitleAlert", () => {
  it("flashes the title while unfocused and restores it on focus", async () => {
    vi.useFakeTimers();
    document.title = "Workspace";

    setDocumentTitleAlert({ active: true, text: ATTENTION_ALERT_TITLE, focused: false });
    expect(document.title).toBe(ATTENTION_ALERT_TITLE);

    await vi.advanceTimersByTimeAsync(1000);
    expect(document.title).toBe("Workspace");
    await vi.advanceTimersByTimeAsync(1000);
    expect(document.title).toBe(ATTENTION_ALERT_TITLE);

    setDocumentTitleAlert({ active: true, text: ATTENTION_ALERT_TITLE, focused: true });
    expect(document.title).toBe("Workspace");
  });

  it("does not flash while the window is focused", async () => {
    vi.useFakeTimers();
    document.title = "Workspace";

    setDocumentTitleAlert({ active: true, text: ATTENTION_ALERT_TITLE, focused: true });
    await vi.advanceTimersByTimeAsync(3000);
    expect(document.title).toBe("Workspace");
  });

  it("restores the newest external title written mid-flash", async () => {
    vi.useFakeTimers();
    document.title = "Workspace";

    setDocumentTitleAlert({ active: true, text: ATTENTION_ALERT_TITLE, focused: false });
    document.title = "Renamed workspace";
    await vi.advanceTimersByTimeAsync(1);

    setDocumentTitleAlert({ active: false, text: "", focused: true });
    expect(document.title).toBe("Renamed workspace");
  });
});

describe("updateWebAppBadge", () => {
  it("sets and clears the app badge through the navigator API", async () => {
    const setAppBadge = vi.fn().mockResolvedValue(undefined);
    const clearAppBadge = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { setAppBadge, clearAppBadge });

    await updateWebAppBadge(3);
    expect(setAppBadge).toHaveBeenCalledWith(3);

    await updateWebAppBadge(undefined);
    expect(clearAppBadge).toHaveBeenCalled();
  });

  it("no-ops when the badge API is missing", async () => {
    vi.stubGlobal("navigator", {});
    await expect(updateWebAppBadge(2)).resolves.toBeUndefined();
  });
});

describe("signalAgentAttentionAlert", () => {
  it("plays the finished chime through the audio context", () => {
    vi.stubGlobal("AudioContext", FakeAudioContext);
    appQueryClient.setQueryData(APP_SETTINGS_QUERY_KEY, { notificationSounds: true });

    signalAgentAttentionAlert("finished");
    expect(createdOscillatorStarts).toHaveLength(2);
  });

  it("plays the permission chime with an extra note", () => {
    vi.stubGlobal("AudioContext", FakeAudioContext);
    appQueryClient.setQueryData(APP_SETTINGS_QUERY_KEY, { notificationSounds: true });

    signalAgentAttentionAlert("permission");
    expect(createdOscillatorStarts).toHaveLength(3);
  });

  it("stays silent when notification sounds are disabled", () => {
    vi.stubGlobal("AudioContext", FakeAudioContext);
    appQueryClient.setQueryData(APP_SETTINGS_QUERY_KEY, { notificationSounds: false });

    signalAgentAttentionAlert("finished");
    expect(createdOscillatorStarts).toHaveLength(0);
  });
});
