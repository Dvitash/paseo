import { isWeb } from "@/constants/platform";
import { createBrowserLifecycle, type BrowserLifecycleEvent } from "./browser-lifecycle";

let source: ReturnType<typeof createBrowserLifecycle> | null = null;

/** One browser event source for the host runtime, visibility hooks and timelines.
 * Keep observing between consumer mounts so a suspension boundary is not lost. */
export function subscribeBrowserLifecycle(
  listener: (event: BrowserLifecycleEvent) => void,
): () => void {
  if (!isWeb || typeof document === "undefined" || typeof window === "undefined") {
    return () => undefined;
  }
  source ??= createBrowserLifecycle({ document, window, now: () => Date.now() });
  return source.subscribe(listener);
}
