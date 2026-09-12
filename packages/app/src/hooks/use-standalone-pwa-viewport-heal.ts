import { useEffect } from "react";
import { isWeb } from "@/constants/platform";
import { isAppleHandheldPlatform } from "@/utils/terminal-keys";

// WebKit bugs (iOS standalone "Add to Home Screen" PWA):
// 1. Launch: innerHeight/100dvh can report short of the painted area, leaving
//    a dead band below the app shell. Compensated by measuring
//    visualViewport.height - innerHeight (the actually-visible region, so it
//    can never overshoot) into --paseo-viewport-compensation.
// 2. Keyboard: the first software-keyboard open can shrink the layout
//    viewport permanently until force-quit. The only known recovery is
//    forcing WebKit to re-measure by flipping display none→flex on a
//    full-viewport-height element with a synchronous reflow in between.
// See docs/development.md ("PWA viewport").
const RESTORE_EPSILON_PX = 4;
const HEAL_DELAY_MS = 140;
// Only compensate shortfalls in the safe-area range. A larger gap means the
// keyboard is up, and extending the shell under it would hide the composer.
const MAX_COMPENSATION_PX = 80;
const COMPENSATION_VAR = "--paseo-viewport-compensation";

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

    // iOS standalone can report innerHeight/100dvh short of the painted area
    // at launch. visualViewport.height is the actually-visible region by
    // definition, so the difference is the exact shortfall — it can never
    // overshoot into unpainted pixels the way screen.height or env() can.
    const applyCompensation = () => {
      const visible = window.visualViewport?.height ?? window.innerHeight;
      const shortfall = visible - window.innerHeight;
      const compensation =
        shortfall > RESTORE_EPSILON_PX && shortfall <= MAX_COMPENSATION_PX ? shortfall : 0;
      document.documentElement.style.setProperty(COMPENSATION_VAR, `${compensation}px`);
    };
    applyCompensation();

    // The display-flip re-measure is the only known recovery for a stuck
    // viewport. Extracted so it can run at mount (stuck-at-launch) without
    // the maxHeight guard, which is initialized to the already-short height.
    const remeasureViewport = () => {
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
    };

    // Stuck-at-launch: if the reported viewport is already short of the
    // physical screen, force a re-measure once. Harmless when nothing is
    // stuck — the flip is a no-op for a healthy viewport.
    if (window.screen.height - window.innerHeight > RESTORE_EPSILON_PX) {
      remeasureViewport();
      maxHeight = window.innerHeight;
      applyCompensation();
    }

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
      remeasureViewport();
      // Do NOT adopt an unrestored height as the baseline: the heal can fire
      // while the keyboard is still dismissing, and lowering maxHeight here
      // would permanently disable later healing. The baseline only resets on
      // a width change (rotation), handled in handleResize.
      applyCompensation();
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
      } else if (window.innerHeight > maxHeight) {
        maxHeight = window.innerHeight;
      } else if (document.activeElement == null || document.activeElement === document.body) {
        // A shrink while nothing editable is focused means the viewport is
        // stuck; a real keyboard-open shrink is followed by a focusout that
        // schedules the heal. A partial recovery (height grew but is still
        // short) also lands here and retries.
        scheduleHeal();
      }
      applyCompensation();
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
      document.documentElement.style.removeProperty(COMPENSATION_VAR);
    };
  }, []);
}
