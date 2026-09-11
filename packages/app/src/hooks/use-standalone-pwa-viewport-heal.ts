import { useEffect } from "react";
import { isWeb } from "@/constants/platform";
import { isAppleHandheldPlatform } from "@/utils/terminal-keys";

// WebKit bug (iOS standalone "Add to Home Screen" PWA): the first time the
// software keyboard opens, the layout viewport shrinks and never grows back
// until the app is force-quit. window.innerHeight, visualViewport.height, and
// 100dvh all stay short, leaving a dead band below the app shell. The only
// known recovery is forcing WebKit to re-measure the viewport by flipping
// display none→flex on a full-viewport-height element with a synchronous
// reflow in between. See docs/development.md ("PWA viewport").
const RESTORE_EPSILON_PX = 4;
const HEAL_DELAY_MS = 140;

export function useStandalonePwaViewportHeal() {
  useEffect(() => {
    if (!isWeb) {
      return;
    }
    const isStandalone =
      ("standalone" in window.navigator && Boolean(window.navigator.standalone)) ||
      (typeof window.matchMedia === "function" &&
        window.matchMedia("(display-mode: standalone)").matches);
    const isIos = isAppleHandheldPlatform({
      userAgent: window.navigator.userAgent,
      platform: window.navigator.platform,
      maxTouchPoints: window.navigator.maxTouchPoints,
    });
    if (!isStandalone || !isIos) {
      return;
    }
    const root = document.getElementById("root");
    if (!root) {
      return;
    }

    let maxHeight = window.innerHeight;
    let lastWidth = window.innerWidth;
    let healTimer: number | undefined;

    const healViewport = () => {
      healTimer = undefined;
      if (maxHeight - window.innerHeight <= RESTORE_EPSILON_PX) {
        return;
      }
      // Focus may have moved to another editable surface during the delay
      // (iOS also reports relatedTarget=null on focusout). Never detach the
      // root while the keyboard is up for a new editor.
      if (
        document.activeElement instanceof HTMLElement &&
        document.activeElement.closest("input, textarea, [contenteditable]")
      ) {
        return;
      }
      // Capture scroll offsets before the flip; WebKit drops them when the
      // subtree is detached from layout.
      const scrolled: Array<{ element: Element; top: number; left: number }> = [];
      for (const element of root.querySelectorAll("*")) {
        if (element.scrollTop > 0 || element.scrollLeft > 0) {
          scrolled.push({ element, top: element.scrollTop, left: element.scrollLeft });
        }
      }
      root.style.display = "none";
      void root.offsetHeight; // synchronous reflow forces the viewport re-measure
      root.style.display = "";
      for (const { element, top, left } of scrolled) {
        element.scrollTop = top;
        element.scrollLeft = left;
      }
      // Do NOT adopt an unrestored height as the baseline: the heal can fire
      // while the keyboard is still dismissing, and lowering maxHeight here
      // would permanently disable later healing. The baseline only resets on
      // a width change (rotation), handled in handleResize.
    };

    const scheduleHeal = () => {
      if (healTimer === undefined) {
        healTimer = window.setTimeout(healViewport, HEAL_DELAY_MS);
      }
    };

    const handleResize = () => {
      if (window.innerWidth !== lastWidth) {
        // Orientation change: the previous height baseline is meaningless.
        lastWidth = window.innerWidth;
        maxHeight = window.innerHeight;
        return;
      }
      if (window.innerHeight > maxHeight) {
        maxHeight = window.innerHeight;
        return;
      }
      // A shrink while nothing editable is focused means the viewport is
      // stuck; a real keyboard-open shrink is followed by a focusout that
      // schedules the heal. A partial recovery (height grew but is still
      // short) also lands here and retries.
      if (document.activeElement == null || document.activeElement === document.body) {
        scheduleHeal();
      }
    };

    const handleFocusOut = (event: FocusEvent) => {
      // Only heal once focus has fully left editable surfaces.
      const next = event.relatedTarget;
      if (next instanceof HTMLElement && next.closest("input, textarea, [contenteditable]")) {
        return;
      }
      scheduleHeal();
    };

    window.addEventListener("resize", handleResize);
    window.visualViewport?.addEventListener("resize", handleResize);
    window.addEventListener("focusout", handleFocusOut);
    return () => {
      window.clearTimeout(healTimer);
      window.removeEventListener("resize", handleResize);
      window.visualViewport?.removeEventListener("resize", handleResize);
      window.removeEventListener("focusout", handleFocusOut);
    };
  }, []);
}
