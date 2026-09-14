export type BrowserResumeReason =
  | "visibilitychange"
  | "pageshow"
  | "focus"
  | "online"
  | "resume";

export type BrowserLifecycleEvent =
  | { type: "hidden"; generation: number }
  | { type: "resume"; generation: number; reason: BrowserResumeReason };

export interface BrowserLifecyclePorts {
  document: EventTarget & { readonly visibilityState: string };
  window: EventTarget;
  now: () => number;
}

const DUPLICATE_SIGNAL_WINDOW_MS = 250;

/** Browser events are edges, not React state. A restore can happen while the
 * last rendered visibility boolean is still true. */
export function createBrowserLifecycle(ports: BrowserLifecyclePorts) {
  const listeners = new Set<(event: BrowserLifecycleEvent) => void>();
  const removers: Array<() => void> = [];
  let generation = 0;
  let hidden = ports.document.visibilityState !== "visible";
  let away = hidden;
  let lastResumeAt = ports.now();

  const emit = (event: BrowserLifecycleEvent) => {
    for (const listener of listeners) listener(event);
  };

  const hide = () => {
    away = true;
    if (hidden) return;
    hidden = true;
    emit({ type: "hidden", generation: ++generation });
  };

  const resume = (reason: BrowserResumeReason) => {
    if (ports.document.visibilityState !== "visible") return;
    const now = ports.now();
    const elapsed = now - lastResumeAt;
    // Coalesce a burst of restoration signals, but never swallow a second real
    // background/foreground or blur/focus boundary, even within this window.
    if (!away && elapsed >= 0 && elapsed < DUPLICATE_SIGNAL_WINDOW_MS) return;
    hidden = false;
    away = false;
    lastResumeAt = now;
    emit({ type: "resume", generation: ++generation, reason });
  };

  const listen = (target: EventTarget, type: string, listener: () => void) => {
    target.addEventListener(type, listener);
    removers.push(() => target.removeEventListener(type, listener));
  };

  listen(ports.document, "visibilitychange", () => {
    if (ports.document.visibilityState === "visible") resume("visibilitychange");
    else hide();
  });
  listen(ports.window, "pagehide", hide);
  listen(ports.window, "pageshow", () => resume("pageshow"));
  listen(ports.window, "blur", () => {
    // Losing window focus is not the same as becoming invisible on desktop.
    away = true;
  });
  listen(ports.window, "focus", () => resume("focus"));
  listen(ports.window, "online", () => resume("online"));
  listen(ports.document, "resume", () => resume("resume"));

  return {
    subscribe(listener: (event: BrowserLifecycleEvent) => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose(): void {
      for (const remove of removers) remove();
      listeners.clear();
    },
  };
}
