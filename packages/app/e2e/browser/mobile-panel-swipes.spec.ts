import { setTimeout } from "node:timers/promises";
import type { CDPSession, Page } from "@playwright/test";
import { expect, test } from "../support/fixtures";
import { gotoWorkspace } from "../support/helpers/launcher";
import { seedWorkspace } from "../support/helpers/seed-client";
import {
  expectMobileAgentSidebarHidden,
  expectMobileAgentSidebarVisible,
  openMobileAgentSidebar,
} from "../support/helpers/sidebar";
import {
  expectTimelinePromptVisible,
  openAgentTimeline,
  seedLongMockAgentTimeline,
} from "../support/helpers/timeline-pagination";

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

interface TouchPoint {
  x: number;
  y: number;
}

async function swipe(cdp: CDPSession, from: TouchPoint, to: TouchPoint): Promise<void> {
  const steps = 10;
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ ...from, id: 0 }],
  });
  for (let i = 1; i <= steps; i++) {
    const x = Math.round(from.x + ((to.x - from.x) * i) / steps);
    const y = Math.round(from.y + ((to.y - from.y) * i) / steps);
    await setTimeout(16);
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x, y, id: 0 }],
    });
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

async function expectPanelsClosed(page: Page): Promise<void> {
  await expect(page.getByTestId("agent-list-backdrop")).not.toBeVisible();
  await expect(page.getByTestId("file-explorer-backdrop")).not.toBeVisible();
  await expectMobileAgentSidebarHidden(page);
  await expect(page.getByTestId("explorer-close")).not.toBeInViewport();
}

async function swipeBothPanels(page: Page, cdp: CDPSession): Promise<void> {
  // Start away from the old 32px edge-only regions, over the scrollable content.
  await swipe(cdp, { x: 180, y: 380 }, { x: 360, y: 380 });
  await expect(page.getByTestId("agent-list-backdrop")).toBeVisible();
  await expectMobileAgentSidebarVisible(page);

  await swipe(cdp, { x: 220, y: 380 }, { x: 40, y: 380 });
  await expectPanelsClosed(page);

  await swipe(cdp, { x: 210, y: 380 }, { x: 30, y: 380 });
  await expect(page.getByTestId("file-explorer-backdrop")).toBeVisible();
  await expect(page.getByTestId("explorer-close")).toBeInViewport({ ratio: 1 });

  await swipe(cdp, { x: 180, y: 380 }, { x: 360, y: 380 });
  await expectPanelsClosed(page);
}

test("horizontal swipes open and close both panels from a draft", async ({ page }) => {
  const seeded = await seedWorkspace({ repoPrefix: "mobile-panel-swipes-" });
  try {
    await gotoWorkspace(page, seeded.workspaceId);
    const cdp = await page.context().newCDPSession(page);
    await expectPanelsClosed(page);
    await swipe(cdp, { x: 195, y: 250 }, { x: 195, y: 450 });
    await expectPanelsClosed(page);
    await swipe(cdp, { x: 195, y: 450 }, { x: 195, y: 250 });
    await expectPanelsClosed(page);
    await swipeBothPanels(page, cdp);
    await cdp.detach();
  } finally {
    await seeded.cleanup();
  }
});

test("chat keeps vertical touch scrolling and horizontal panel swipes", async ({ page }) => {
  const agent = await seedLongMockAgentTimeline({ turns: 6 });
  try {
    await openAgentTimeline(page, agent);
    await expectTimelinePromptVisible(page, agent.newestPrompt);
    const chat = page.getByTestId("agent-chat-scroll").filter({ visible: true });
    const cdp = await page.context().newCDPSession(page);
    await expect.poll(() => chat.evaluate((element) => element.scrollTop)).toBeGreaterThan(200);
    const before = await chat.evaluate((element) => element.scrollTop);
    await swipe(cdp, { x: 195, y: 250 }, { x: 195, y: 450 });
    await expect.poll(() => chat.evaluate((element) => element.scrollTop)).toBeLessThan(before);
    await expectPanelsClosed(page);
    await swipeBothPanels(page, cdp);
    await cdp.detach();
  } finally {
    await agent.cleanup();
  }
});

async function expectViewportFit(page: Page, height: number): Promise<void> {
  await expect
    .poll(() =>
      page.locator("#root").evaluate((root) => {
        const rect = root.getBoundingClientRect();
        return { top: rect.top, bottom: rect.bottom, viewport: window.innerHeight };
      }),
    )
    .toEqual({ top: 0, bottom: height, viewport: height });
  const composer = page.getByTestId("message-input-root").filter({ visible: true }).first();
  await expect(composer).toBeInViewport({ ratio: 1 });
  // Chromium's emulated phone has no home-indicator inset; only the 16px composer gutter remains.
  await expect
    .poll(() =>
      composer.evaluate((element) => {
        return window.innerHeight - element.getBoundingClientRect().bottom;
      }),
    )
    .toBe(16);
}

test("mobile shell and composer follow viewport height changes without a bottom gap", async ({
  page,
}) => {
  const seeded = await seedWorkspace({ repoPrefix: "mobile-shell-resize-" });
  try {
    await gotoWorkspace(page, seeded.workspaceId);
    await expectViewportFit(page, 844);
    await page.setViewportSize({ width: 390, height: 600 });
    await expectViewportFit(page, 600);
    await page.setViewportSize({ width: 390, height: 844 });
    await expectViewportFit(page, 844);
    await page.screenshot({ path: test.info().outputPath("mobile-shell.png") });
  } finally {
    await seeded.cleanup();
  }
});

test("open sidebar panel and footer reach the viewport bottom", async ({ page }) => {
  const seeded = await seedWorkspace({ repoPrefix: "mobile-sidebar-fit-" });
  try {
    await gotoWorkspace(page, seeded.workspaceId);
    await openMobileAgentSidebar(page);
    await expectMobileAgentSidebarVisible(page);
    const boxes = await page.evaluate(() => {
      const rect = (selector: string) => {
        const element = document.querySelector(selector);
        if (!element) return null;
        const box = element.getBoundingClientRect();
        return { top: box.top, bottom: box.bottom };
      };
      return {
        viewport: window.innerHeight,
        root: rect("#root"),
        gestureHost: rect("#agent-list-gesture-host"),
        footer: rect('[data-testid="sidebar-footer"]'),
      };
    });
    expect(boxes.root).not.toBeNull();
    expect(boxes.gestureHost).not.toBeNull();
    expect(boxes.footer).not.toBeNull();
    // The shell, the overlay host, and the sidebar footer must all reach the
    // viewport bottom — a short root or an oversized bottom inset both leave a
    // dead band below the sidebar.
    expect(boxes.root!.bottom).toBe(boxes.viewport);
    expect(boxes.gestureHost!.bottom).toBe(boxes.viewport);
    expect(Math.abs(boxes.footer!.bottom - boxes.viewport)).toBeLessThanOrEqual(2);
  } finally {
    await seeded.cleanup();
  }
});
