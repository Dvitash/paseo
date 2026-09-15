const HEIGHT_VAR = "--paseo-viewport-height";
const TOP_VAR = "--paseo-viewport-top";
// Focus alone is not a keyboard signal (autofocus and hardware keyboards).
// Ignore status-bar/safe-area-sized discrepancies in WebKit's visual viewport.
const MIN_KEYBOARD_HEIGHT = 120;
const SETTLE_DELAY_MS = 400;

function hasFocusedEditor(document: Document): boolean {
  const element = document.activeElement;
  if (!element) return false;
  if ("isContentEditable" in element && element.isContentEditable) return true;
  if (!element.matches("input, textarea")) return false;
  if ("disabled" in element && element.disabled) return false;
  if ("readOnly" in element && element.readOnly) return false;
  return !element.matches(
    'input[type="button"], input[type="submit"], input[type="reset"], input[type="checkbox"], input[type="radio"], input[type="range"], input[type="color"], input[type="file"], input[type="hidden"]',
  );
}

// The pre-paint script in public/index.html owns platform detection. Keep the
// body at 100lvh as an independent, rotation-aware measurement; only #root
// follows the software keyboard. Never measure a root we have already resized.
export function installStandalonePwaViewport(view: Window): (() => void) | undefined {
  const document = view.document;
  const html = document.documentElement;
  const body = document.body;
  if (!html.classList.contains("ios-standalone") || !body || !document.getElementById("root")) {
    return;
  }

  const previousStyles = [HEIGHT_VAR, TOP_VAR].map((name) => ({
    name,
    value: html.style.getPropertyValue(name),
    priority: html.style.getPropertyPriority(name),
  }));
  const viewport = view.visualViewport;
  let frame: number | undefined;
  let settleTimer: number | undefined;

  const setPixels = (name: string, value: number) => {
    const next = `${value}px`;
    if (html.style.getPropertyValue(name) !== next) html.style.setProperty(name, next);
  };

  const synchronize = () => {
    frame = undefined;
    if (document.visibilityState === "hidden") return;
    // Pinch zoom also shrinks visualViewport. Leave page zoom/pan to the browser.
    if (viewport && Math.abs(viewport.scale - 1) > 0.01) return;

    const layoutHeight = body.getBoundingClientRect().height;
    const visibleHeight = viewport?.height ?? view.innerHeight;
    if (!Number.isFinite(layoutHeight) || layoutHeight <= 0) return;
    const keyboardOpen =
      hasFocusedEditor(document) &&
      Number.isFinite(visibleHeight) &&
      visibleHeight > 0 &&
      layoutHeight - visibleHeight > MIN_KEYBOARD_HEIGHT;

    if (keyboardOpen) {
      // #root is absolute in the document, not fixed in the layout viewport.
      // pageTop includes both the layout scroll and keyboard-induced visual pan.
      const top = viewport?.pageTop ?? view.scrollY;
      setPixels(TOP_VAR, Number.isFinite(top) ? Math.max(0, top) : 0);
      setPixels(HEIGHT_VAR, visibleHeight);
    } else {
      setPixels(TOP_VAR, 0);
      // Let CSS fill the large viewport even if innerHeight and visualViewport
      // agree on the same short value. Subtracting those values returned zero.
      html.style.removeProperty(HEIGHT_VAR);
      if (view.scrollX !== 0 || view.scrollY !== 0) view.scrollTo(0, 0);
    }
  };

  const schedule = () => {
    if (frame === undefined) frame = view.requestAnimationFrame(synchronize);
  };
  const settle = () => {
    schedule();
    view.clearTimeout(settleTimer);
    // WebKit can publish the final metrics after focus/pageshow/orientation.
    settleTimer = view.setTimeout(schedule, SETTLE_DELAY_MS);
  };

  synchronize();
  view.addEventListener("resize", schedule);
  view.addEventListener("orientationchange", settle);
  view.addEventListener("pageshow", settle);
  document.addEventListener("visibilitychange", settle);
  document.addEventListener("focusin", settle);
  document.addEventListener("focusout", settle);
  viewport?.addEventListener("resize", schedule);
  viewport?.addEventListener("scroll", schedule);

  return () => {
    if (frame !== undefined) view.cancelAnimationFrame(frame);
    view.clearTimeout(settleTimer);
    view.removeEventListener("resize", schedule);
    view.removeEventListener("orientationchange", settle);
    view.removeEventListener("pageshow", settle);
    document.removeEventListener("visibilitychange", settle);
    document.removeEventListener("focusin", settle);
    document.removeEventListener("focusout", settle);
    viewport?.removeEventListener("resize", schedule);
    viewport?.removeEventListener("scroll", schedule);
    for (const { name, value, priority } of previousStyles) {
      if (value) html.style.setProperty(name, value, priority);
      else html.style.removeProperty(name);
    }
  };
}
