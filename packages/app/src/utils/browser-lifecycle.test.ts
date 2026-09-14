import { expect, test } from "vitest";
import { createBrowserLifecycle, type BrowserLifecycleEvent } from "./browser-lifecycle";

class TestDocument extends EventTarget {
  visibilityState = "visible";
}

function setup() {
  const document = new TestDocument();
  const window = new EventTarget();
  let now = 0;
  const events: BrowserLifecycleEvent[] = [];
  const lifecycle = createBrowserLifecycle({ document, window, now: () => now });
  lifecycle.subscribe((event) => events.push(event));
  return {
    document,
    window,
    events,
    lifecycle,
    advance(ms: number) {
      now += ms;
    },
    visibility(state: string) {
      document.visibilityState = state;
      document.dispatchEvent(new Event("visibilitychange"));
    },
  };
}

test("a PWA resumes even when no hidden visibility event was delivered", () => {
  const app = setup();
  app.advance(10_000);
  app.window.dispatchEvent(new Event("pageshow"));
  expect(app.events).toEqual([{ type: "resume", generation: 1, reason: "pageshow" }]);
  app.lifecycle.dispose();
});

test("visibility, pageshow and focus for the same return are coalesced", () => {
  const app = setup();
  app.visibility("hidden");
  app.visibility("visible");
  app.window.dispatchEvent(new Event("pageshow"));
  app.window.dispatchEvent(new Event("focus"));
  expect(app.events).toEqual([
    { type: "hidden", generation: 1 },
    { type: "resume", generation: 2, reason: "visibilitychange" },
  ]);
  app.lifecycle.dispose();
});

test("a second genuine return is not lost inside the deduplication window", () => {
  const app = setup();
  app.visibility("hidden");
  app.visibility("visible");
  app.visibility("hidden");
  app.visibility("visible");
  expect(app.events.map((event) => event.type)).toEqual(["hidden", "resume", "hidden", "resume"]);
  app.lifecycle.dispose();
});

test("pagehide marks suspension even while the document still reports visible", () => {
  const app = setup();
  app.window.dispatchEvent(new Event("pagehide"));
  app.window.dispatchEvent(new Event("pageshow"));
  expect(app.events).toEqual([
    { type: "hidden", generation: 1 },
    { type: "resume", generation: 2, reason: "pageshow" },
  ]);
  app.lifecycle.dispose();
});

test("blur/focus is a recovery boundary but blur alone does not hide a desktop window", () => {
  const app = setup();
  app.window.dispatchEvent(new Event("blur"));
  expect(app.events).toEqual([]);
  app.window.dispatchEvent(new Event("focus"));
  expect(app.events).toEqual([{ type: "resume", generation: 1, reason: "focus" }]);
  app.lifecycle.dispose();
});

test("online only requests foreground recovery while the document is visible", () => {
  const app = setup();
  app.visibility("hidden");
  app.advance(1_000);
  app.window.dispatchEvent(new Event("online"));
  expect(app.events).toEqual([{ type: "hidden", generation: 1 }]);
  app.visibility("visible");
  app.advance(1_000);
  app.window.dispatchEvent(new Event("online"));
  expect(app.events.at(-1)).toEqual({ type: "resume", generation: 3, reason: "online" });
  app.lifecycle.dispose();
});

test("disposing removes browser listeners", () => {
  const app = setup();
  app.lifecycle.dispose();
  app.visibility("hidden");
  app.visibility("visible");
  expect(app.events).toEqual([]);
});
