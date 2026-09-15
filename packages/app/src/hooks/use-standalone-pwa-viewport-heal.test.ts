// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useStandalonePwaViewportHeal } from "./use-standalone-pwa-viewport-heal";

const HEIGHT = "--paseo-viewport-height";
const TOP = "--paseo-viewport-top";
let root: HTMLDivElement;
let input: HTMLTextAreaElement;
let layoutHeight: number;
let viewport: EventTarget & { height: number; pageTop: number; scale: number };

function flush() {
  act(() => vi.advanceTimersByTime(20));
}
function resize(height: number, pageTop = 0) {
  viewport.height = height;
  viewport.pageTop = pageTop;
  viewport.dispatchEvent(new Event("resize"));
  flush();
}
function heightStyle() {
  return document.documentElement.style.getPropertyValue(HEIGHT);
}
function topStyle() {
  return document.documentElement.style.getPropertyValue(TOP);
}

beforeEach(() => {
  vi.useFakeTimers();
  document.documentElement.classList.add("ios-standalone");
  root = document.createElement("div");
  root.id = "root";
  input = document.createElement("textarea");
  input.value = "Keep this draft";
  root.appendChild(input);
  document.body.appendChild(root);
  layoutHeight = 844;
  vi.spyOn(document.body, "getBoundingClientRect").mockImplementation(
    () => ({ height: layoutHeight }) as DOMRect,
  );
  viewport = Object.assign(new EventTarget(), { height: 785, pageTop: 0, scale: 1 });
  vi.stubGlobal("visualViewport", viewport);
  vi.stubGlobal("innerHeight", 785);
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) =>
    window.setTimeout(() => callback(0), 16),
  );
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => window.clearTimeout(id));
});

afterEach(() => {
  cleanup();
  root.remove();
  document.documentElement.classList.remove("ios-standalone");
  document.documentElement.style.removeProperty(HEIGHT);
  document.documentElement.style.removeProperty(TOP);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("useStandalonePwaViewportHeal", () => {
  it("leaves the full-height CSS shell in charge when both reported heights are short", () => {
    input.focus(); // Autofocus does not imply a software keyboard.
    renderHook(() => useStandalonePwaViewportHeal());
    expect(heightStyle()).toBe("");
    expect(topStyle()).toBe("0px");
    expect(document.activeElement).toBe(input);
  });

  it("positions the root in document coordinates above a keyboard present at mount", () => {
    input.focus();
    viewport.height = 500;
    viewport.pageTop = 80;
    renderHook(() => useStandalonePwaViewportHeal());
    expect(heightStyle()).toBe("500px");
    expect(topStyle()).toBe("80px");
    expect(root.style.display).toBe("");
  });

  it("restores full height on keyboard dismissal even when the textarea stays focused", () => {
    renderHook(() => useStandalonePwaViewportHeal());
    input.focus();
    resize(500, 80);
    expect(heightStyle()).toBe("500px");
    resize(785);
    expect(heightStyle()).toBe("");
    expect(topStyle()).toBe("0px");
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe("Keep this draft");
  });

  it("restores full height on blur even if visualViewport is still keyboard-sized", () => {
    renderHook(() => useStandalonePwaViewportHeal());
    input.focus();
    resize(500);
    input.blur();
    flush();
    expect(heightStyle()).toBe("");
  });

  it("does not detach the root or reset a nested scroller during recovery", () => {
    const scroller = document.createElement("div");
    scroller.scrollTop = 320;
    root.appendChild(scroller);
    const displaySetter = vi.spyOn(root.style, "display", "set");
    renderHook(() => useStandalonePwaViewportHeal());
    input.focus();
    resize(500);
    resize(785);
    expect(displaySetter).not.toHaveBeenCalled();
    expect(scroller.scrollTop).toBe(320);
  });

  it("keeps keyboard sizing when focus moves between editors", () => {
    const second = document.createElement("textarea");
    root.appendChild(second);
    renderHook(() => useStandalonePwaViewportHeal());
    input.focus();
    resize(500);
    second.focus();
    flush();
    expect(heightStyle()).toBe("500px");
    expect(document.activeElement).toBe(second);
  });

  it("reconciles on pageshow without requiring a resize event", () => {
    renderHook(() => useStandalonePwaViewportHeal());
    input.focus();
    resize(500, 80);
    viewport.height = 785;
    viewport.pageTop = 0;
    window.dispatchEvent(new Event("pageshow"));
    flush();
    expect(heightStyle()).toBe("");
    expect(topStyle()).toBe("0px");
  });

  it("reconciles after foregrounding when metrics changed while hidden", () => {
    let visibility = "visible";
    vi.spyOn(document, "visibilityState", "get").mockImplementation(
      () => visibility as DocumentVisibilityState,
    );
    renderHook(() => useStandalonePwaViewportHeal());
    input.focus();
    resize(500);
    visibility = "hidden";
    resize(785);
    expect(heightStyle()).toBe("500px");
    visibility = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    flush();
    expect(heightStyle()).toBe("");
  });

  it("samples late metrics after a lifecycle event", () => {
    renderHook(() => useStandalonePwaViewportHeal());
    input.focus();
    resize(500);
    window.dispatchEvent(new Event("pageshow"));
    flush();
    viewport.height = 785; // No final resize event from WebKit.
    act(() => vi.advanceTimersByTime(450));
    expect(heightStyle()).toBe("");
  });

  it("uses the current CSS viewport after rotation or window resizing", () => {
    renderHook(() => useStandalonePwaViewportHeal());
    input.focus();
    resize(500);
    layoutHeight = 390;
    viewport.height = 390;
    window.dispatchEvent(new Event("orientationchange"));
    flush();
    expect(heightStyle()).toBe("");
    resize(210);
    expect(heightStyle()).toBe("210px");
  });

  it("does not mistake pinch zoom for the keyboard", () => {
    renderHook(() => useStandalonePwaViewportHeal());
    input.focus();
    viewport.scale = 2;
    resize(400, 100);
    expect(heightStyle()).toBe("");
    expect(topStyle()).toBe("0px");
    viewport.scale = 1;
    resize(785);
    expect(heightStyle()).toBe("");
  });

  it("handles visual viewport pan without a resize", () => {
    renderHook(() => useStandalonePwaViewportHeal());
    input.focus();
    resize(500);
    viewport.pageTop = 40;
    viewport.dispatchEvent(new Event("scroll"));
    flush();
    expect(topStyle()).toBe("40px");
  });

  it("does not treat a readonly input as a software keyboard", () => {
    input.readOnly = true;
    input.focus();
    viewport.height = 500;
    renderHook(() => useStandalonePwaViewportHeal());
    expect(heightStyle()).toBe("");
  });

  it("is inert without the iOS-standalone gate", () => {
    document.documentElement.classList.remove("ios-standalone");
    input.focus();
    viewport.height = 500;
    renderHook(() => useStandalonePwaViewportHeal());
    expect(heightStyle()).toBe("");
    expect(topStyle()).toBe("");
  });

  it("falls back to innerHeight when visualViewport is unavailable", () => {
    vi.stubGlobal("visualViewport", undefined);
    vi.stubGlobal("innerHeight", 500);
    input.focus();
    renderHook(() => useStandalonePwaViewportHeal());
    expect(heightStyle()).toBe("500px");
  });

  it("restores prior styles and cancels pending work on unmount", () => {
    document.documentElement.style.setProperty(HEIGHT, "700px", "important");
    const { unmount } = renderHook(() => useStandalonePwaViewportHeal());
    input.focus();
    viewport.height = 500;
    window.dispatchEvent(new Event("pageshow"));
    unmount();
    act(() => vi.advanceTimersByTime(500));
    expect(heightStyle()).toBe("700px");
    expect(document.documentElement.style.getPropertyPriority(HEIGHT)).toBe("important");
    resize(450);
    expect(heightStyle()).toBe("700px");
  });
});
