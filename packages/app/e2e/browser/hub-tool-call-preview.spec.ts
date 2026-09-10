import type { Page } from "@playwright/test";
import { test, expect } from "../support/fixtures";
import { expectComposerVisible, submitMessage } from "../support/helpers/composer";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";

async function configureDetailedToolCalls(
  page: Page,
  themePreference: "light" | "dark" = "dark",
): Promise<void> {
  await page.addInitScript((theme) => {
    localStorage.setItem(
      "@paseo:app-settings",
      JSON.stringify({ toolCallDetailLevel: "detailed", theme }),
    );
  }, themePreference);
}

test.describe("Hub tool call previews in activity stream", () => {
  test("observes live running hub activity preview after opening route", async ({
    page,
  }, testInfo) => {
    await configureDetailedToolCalls(page);

    const agent = await seedMockAgentWorkspace({
      repoPrefix: `hub-preview-live-${testInfo.workerIndex}-`,
      title: "Hub preview live stream",
    });

    try {
      await openAgentRoute(page, agent);
      await expectComposerVisible(page);

      await submitMessage(page, "replay hub activity previews with 1000ms tick interval");

      // While streaming, tool call badge and preview appear before turn completes
      const liveBadge = page.getByTestId("tool-call-badge").first();
      await expect(liveBadge).toBeVisible({ timeout: 15_000 });
      await expect(liveBadge.getByTestId("tool-call-preview")).toBeVisible();
      await expect(liveBadge.locator('[role="button"]').first()).toHaveAttribute(
        "aria-busy",
        "true",
      );

      // Ensure running input or log update is visible during live stream
      await expect(liveBadge.getByText(/Deploying build|Worker|web-server/i).first()).toBeVisible();

      // Wait for turn completion
      await agent.client.waitForAgentUpsert(
        agent.agentId,
        (snapshot) => snapshot.status === "idle",
        30_000,
      );

      // Verify badges settled into completed state
      const settledBadges = page.getByTestId("tool-call-badge");
      await expect(settledBadges.first()).toBeVisible();
      await expect(settledBadges.first().locator('[role="button"]').first()).toHaveAttribute(
        "aria-busy",
        "false",
      );
      expect(await settledBadges.count()).toBeGreaterThanOrEqual(5);
    } finally {
      await agent.cleanup();
    }
  });

  test("renders unexpanded hub previews on desktop and supports full log expansion", async ({
    page,
  }, testInfo) => {
    await configureDetailedToolCalls(page);

    const agent = await seedMockAgentWorkspace({
      repoPrefix: `hub-preview-desktop-${testInfo.workerIndex}-`,
      title: "Hub preview desktop",
      initialPrompt: "replay hub activity previews",
    });

    try {
      await agent.client.waitForAgentUpsert(
        agent.agentId,
        (snapshot) => snapshot.status === "idle",
        30_000,
      );

      await openAgentRoute(page, agent);
      await expectComposerVisible(page);

      // 1. Peer Send: unexpanded message and delivery receipt visible without JSON
      const sendPeerBadge = page
        .getByTestId("tool-call-badge")
        .filter({ hasText: /send/i })
        .filter({ hasText: /Worker/i })
        .first();
      await expect(sendPeerBadge).toBeVisible({ timeout: 15_000 });
      const sendPeerHeader = sendPeerBadge.locator('[role="button"]').first();
      await expect(sendPeerHeader).toHaveAttribute("aria-expanded", "false");

      const sendPeerPreview = sendPeerBadge.getByTestId("tool-call-preview");
      await expect(sendPeerPreview).toBeVisible();
      await expect(
        sendPeerBadge.getByText("Deploying build v2.1 to staging cluster"),
      ).toBeVisible();
      await expect(sendPeerBadge.getByText(/injected|Delivered/i).first()).toBeVisible();

      const sendPeerText = await sendPeerPreview.innerText();
      expect(sendPeerText).not.toContain('"op":');
      expect(sendPeerText).not.toContain('"receipts":');
      await sendPeerBadge.scrollIntoViewIfNeeded();
      await page.screenshot({ path: testInfo.outputPath("hub-message-desktop.png") });

      // 2. Empty Inbox: empty state text visible without JSON
      const inboxBadge = page.getByTestId("tool-call-badge").filter({ hasText: /inbox/i }).first();
      await expect(inboxBadge).toBeVisible();
      const inboxPreview = inboxBadge.getByTestId("tool-call-preview");
      await expect(inboxPreview).toBeVisible();
      await expect(inboxBadge.getByText(/Inbox empty|empty/i).first()).toBeVisible();

      const inboxText = await inboxPreview.innerText();
      expect(inboxText).not.toContain('"inbox":');

      // 3. Peer Roster (list): peer details visible without JSON
      const listBadge = page
        .getByTestId("tool-call-badge")
        .filter({ hasText: /list|roster/i })
        .first();
      await expect(listBadge).toBeVisible();
      const listPreview = listBadge.getByTestId("tool-call-preview");
      await expect(listPreview).toBeVisible();
      await expect(listBadge.getByText(/Compiling production assets/i)).toBeVisible();

      const listText = await listPreview.innerText();
      expect(listText).not.toContain('"peers":');

      // 4. Completed Jobs (jobs): resultText visible without JSON
      const jobsBadge = page.getByTestId("tool-call-badge").filter({ hasText: /jobs/i }).first();
      await expect(jobsBadge).toBeVisible();
      const jobsPreview = jobsBadge.getByTestId("tool-call-preview");
      await expect(jobsPreview).toBeVisible();
      await expect(
        jobsBadge.getByText("Artifacts built successfully: bundle.js (142KB)"),
      ).toBeVisible();

      const jobsText = await jobsPreview.innerText();
      expect(jobsText).not.toContain('"resultText":');

      // 5. Process Start: daemon metadata visible without JSON
      const startBadge = page
        .getByTestId("tool-call-badge")
        .filter({ hasText: /start/i })
        .filter({ hasText: /web-server/i })
        .first();
      await expect(startBadge).toBeVisible();
      const startPreview = startBadge.getByTestId("tool-call-preview");
      await expect(startPreview).toBeVisible();
      await expect(startBadge.getByText(/bun|ready|4120/i).first()).toBeVisible();

      const startText = await startPreview.innerText();
      expect(startText).not.toContain('"daemon":');

      // 6. Process Logs: multiline log lines unexpanded, full expansion reveals sentinel
      const logsBadge = page
        .getByTestId("tool-call-badge")
        .filter({ hasText: /logs/i })
        .filter({ hasText: /web-server/i })
        .first();
      await expect(logsBadge).toBeVisible();
      const logsHeader = logsBadge.locator('[role="button"]').first();
      await expect(logsHeader).toHaveAttribute("aria-expanded", "false");

      const logsPreview = logsBadge.getByTestId("tool-call-preview");
      await expect(logsPreview).toBeVisible();
      await expect(logsBadge.getByText(/ready on port 3000/i).first()).toBeVisible();

      const logsText = await logsPreview.innerText();
      expect(logsText).not.toContain('"cursor":');

      // In preview, trailing sentinel is clipped
      await expect(logsBadge.getByText("LOG_SENTINEL_SERVER_READY_OK")).not.toBeVisible();

      // Expand to full details by clicking header (or Show more if present)
      const showMoreButton = logsBadge.getByRole("button", { name: "Show more" });
      await expect(showMoreButton).toBeVisible();
      await showMoreButton.click();
      await expect(logsHeader).toHaveAttribute("aria-expanded", "true");

      // Sentinel is visible in full expanded view
      await expect(logsBadge.getByText("LOG_SENTINEL_SERVER_READY_OK")).toBeVisible();

      // Second click on header collapses back to preview
      await logsHeader.click();
      await expect(logsHeader).toHaveAttribute("aria-expanded", "false");
      await expect(logsBadge.getByTestId("tool-call-preview")).toBeVisible();
      await expect(logsBadge.getByText("LOG_SENTINEL_SERVER_READY_OK")).not.toBeVisible();

      // 7. Process Send: keys CTRL_C and target web-server visible
      const sendProcessBadge = page
        .getByTestId("tool-call-badge")
        .filter({ hasText: /send/i })
        .filter({ hasText: /web-server/i })
        .first();
      await expect(sendProcessBadge).toBeVisible();
      const sendProcessPreview = sendProcessBadge.getByTestId("tool-call-preview");
      await expect(sendProcessPreview).toBeVisible();
      await expect(sendProcessBadge.getByText(/CTRL_C|web-server/i).first()).toBeVisible();

      // Desktop screenshot attached to testInfo
      await testInfo.attach("hub-tool-call-preview-desktop", {
        body: await page.screenshot({
          path: testInfo.outputPath("hub-tool-call-preview-desktop.png"),
        }),
        contentType: "image/png",
      });
    } finally {
      await agent.cleanup();
    }
  });

  test("renders hub previews in timeline on compact layout and opens details in bottom sheet", async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await configureDetailedToolCalls(page, "light");

    const agent = await seedMockAgentWorkspace({
      repoPrefix: `hub-preview-compact-${testInfo.workerIndex}-`,
      title: "Hub preview compact",
      initialPrompt: "replay hub activity previews",
    });

    try {
      await agent.client.waitForAgentUpsert(
        agent.agentId,
        (snapshot) => snapshot.status === "idle",
        30_000,
      );

      await openAgentRoute(page, agent);
      await expectComposerVisible(page);

      // On compact layout: peer send badge renders preview in timeline
      const sendBadge = page
        .getByTestId("tool-call-badge")
        .filter({ hasText: /send/i })
        .filter({ hasText: /Worker/i })
        .first();
      await expect(sendBadge).toBeVisible({ timeout: 15_000 });
      await expect(sendBadge.getByTestId("tool-call-preview")).toBeVisible();

      // Clicking header opens bottom sheet rather than expanding inline
      const sendHeader = sendBadge.locator('[role="button"]').first();
      await sendHeader.click();

      // Bottom sheet is opened
      const sheetCloseButton = page.getByTestId("tool-call-sheet-close");
      await expect(sheetCloseButton).toBeVisible();

      // Preview remains visible in timeline behind sheet
      await expect(sendBadge.getByTestId("tool-call-preview")).toBeVisible();

      // Close bottom sheet
      await sheetCloseButton.click();
      await expect(sheetCloseButton).not.toBeVisible();

      // Compact screenshot attached to testInfo
      await testInfo.attach("hub-tool-call-preview-compact", {
        body: await page.screenshot({
          path: testInfo.outputPath("hub-tool-call-preview-compact.png"),
        }),
        contentType: "image/png",
      });
    } finally {
      await agent.cleanup();
    }
  });
});
