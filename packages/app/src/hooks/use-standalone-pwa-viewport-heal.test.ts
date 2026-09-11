// @vitest-environment jsdom

import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useStandalonePwaViewportHeal } from "./use-standalone-pwa-viewport-heal";

const IPHONE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1";
const PIXEL_UA =
  "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36";

let root: HTMLDivElement;
let displayAtReflow: string | null;

function setViewport(width: number, height: number) {
  Object.defineProperty(window, "innerWidth", { value: width, configurable: true });
  Object.defineProperty(window, "innerHeight", { value: height, configurable: true });
}

function setUserAgent(userAgent: string) {
  Object.defineProperty(window.navigator, "userAgent", { value: userAgent, configurable: true });
  Object.defineProperty(window.navigator, "platform", {
    value: userAgent.includes("iPhone") ? "iPhone" : "Linux armv81",
    configurable: true,
  });
  Object.defineProperty(window.navigator, "maxTouchPoints", {
    value: 5,
    configurable: true,
  });
}

function setStandalone(standalone: boolean) {
  Object.defineProperty(window.navigator, "standalone", {
    value: standalone,
    configurable: true,
  });
}

function fireFocusOut(relatedTarget: EventTarget | null = null) {
  const event = new Event("focusout", { bubbles: true });
  Object.defineProperty(event, "relatedTarget", { value: relatedTarget });
  window.dispatchEvent(event);
}

function fireResize() {
  window.dispatchEvent(new Event("resize"));
}

beforeEach(() => {
  vi.useFakeTimers();
  root = document.createElement("div");
  root.id = "root";
  document.body.appendChild(root);
  displayAtReflow = null;
  // The hook reads offsetHeight while display is "none"; capture the display
  // value at that moment to observe the flip.
  vi.spyOn(root, "offsetHeight", "get").mockImplementation(() => {
    displayAtReflow = root.style.display;
    return 0;
  });
  setViewport(390, 844);
  setUserAgent(IPHONE_UA);
  setStandalone(true);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  root.remove();
});

describe("useStandalonePwaViewportHeal", () => {
  it("flips #root display to force a viewport re-measure after keyboard close", () => {
    renderHook(() => useStandalonePwaViewportHeal());
    // Keyboard opened and closed: viewport stuck short.
    setViewport(390, 785);
    fireFocusOut();
    vi.advanceTimersByTime(200);
    expect(displayAtReflow).toBe("none");
    expect(root.style.display).toBe("");
  });

  it("does nothing when the viewport is not stuck", () => {
    renderHook(() => useStandalonePwaViewportHeal());
    fireFocusOut();
    vi.advanceTimersByTime(200);
    expect(displayAtReflow).toBeNull();
  });

  it("does nothing outside standalone display mode", () => {
    setStandalone(false);
    renderHook(() => useStandalonePwaViewportHeal());
    setViewport(390, 785);
    fireFocusOut();
    vi.advanceTimersByTime(200);
    expect(displayAtReflow).toBeNull();
  });

  it("skips the flip when focus moved to another editable during the delay", () => {
    renderHook(() => useStandalonePwaViewportHeal());
    setViewport(390, 785);
    fireFocusOut();
    // Before the 140ms timer fires, focus lands on a new input (iOS reports
    // relatedTarget=null, so the schedule-time check cannot catch this).
    const input = document.createElement("input");
    root.appendChild(input);
    input.focus();
    vi.advanceTimersByTime(200);
    expect(displayAtReflow).toBeNull();
    // When that editor blurs, the heal retries.
    input.blur();
    fireFocusOut();
    vi.advanceTimersByTime(200);
    expect(displayAtReflow).toBe("none");
  });
  it("does nothing on non-iOS standalone installs", () => {
    setUserAgent(PIXEL_UA);
    renderHook(() => useStandalonePwaViewportHeal());
    setViewport(390, 785);
    fireFocusOut();
    vi.advanceTimersByTime(200);
    expect(displayAtReflow).toBeNull();
  });

  it("keeps the height baseline when a heal fires mid-dismissal and retries on recovery", () => {
    renderHook(() => useStandalonePwaViewportHeal());
    setViewport(390, 785);
    fireFocusOut();
    vi.advanceTimersByTime(200);
    expect(displayAtReflow).toBe("none");
    // The flip did not restore the height (keyboard still animating away).
    // A later partial recovery must trigger another heal, not a new baseline.
    displayAtReflow = null;
    setViewport(390, 800);
    fireResize();
    vi.advanceTimersByTime(200);
    expect(displayAtReflow).toBe("none");
  });

  it("resets the baseline only when the width changes (rotation)", () => {
    renderHook(() => useStandalonePwaViewportHeal());
    setViewport(844, 390);
    fireResize();
    // Landscape height is the new baseline; no heal should fire.
    fireFocusOut();
    vi.advanceTimersByTime(200);
    expect(displayAtReflow).toBeNull();
  });

  it("schedules a heal when the viewport shrinks with nothing focused", () => {
    renderHook(() => useStandalonePwaViewportHeal());
    setViewport(390, 785);
    fireResize();
    vi.advanceTimersByTime(200);
    expect(displayAtReflow).toBe("none");
  });
});
