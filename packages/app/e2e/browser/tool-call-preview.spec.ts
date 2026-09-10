import type { Page } from "@playwright/test";
import { test, expect } from "../support/fixtures";
import { expectComposerVisible } from "../support/helpers/composer";
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

test.describe("Tool call previews in activity stream", () => {
  test("renders tool call previews on desktop and supports expanding to full details", async ({
    page,
  }, testInfo) => {
    await configureDetailedToolCalls(page);

    const agent = await seedMockAgentWorkspace({
      repoPrefix: `tool-call-preview-desktop-${testInfo.workerIndex}-`,
      title: "Tool call preview desktop",
      initialPrompt: "replay tool activity previews",
    });

    try {
      await agent.client.waitForAgentUpsert(
        agent.agentId,
        (snapshot) => snapshot.status === "idle",
        30_000,
      );

      await openAgentRoute(page, agent);
      await expectComposerVisible(page);

      // 1. Eval (Python): code and output visible in preview without expanding, no escaped JSON
      const evalBadge = page
        .getByTestId("tool-call-badge")
        .filter({ hasText: "Calculate Fibonacci" });
      await expect(evalBadge).toBeVisible({ timeout: 15_000 });
      const evalHeader = evalBadge.locator('[role="button"]').first();
      await expect(evalHeader).toHaveAttribute("aria-expanded", "false");

      const evalPreview = evalBadge.getByTestId("tool-call-preview");
      await expect(evalPreview).toBeVisible();
      await expect(evalBadge.getByTestId("tool-eval-content")).toBeVisible();
      await expect(evalBadge.getByText("def fibonacci(n):")).toBeVisible();
      await expect(evalBadge.getByText("[0, 1, 1, 2, 3, 5, 8, 13]")).toBeVisible();

      const evalText = await evalPreview.innerText();
      expect(evalText).not.toContain('"language":');
      expect(evalText).not.toContain('"details":');
      expect(evalText).not.toContain('"cells":');
      await evalBadge.scrollIntoViewIfNeeded();
      await page.screenshot({ path: testInfo.outputPath("eval-preview-desktop.png") });

      // Expand eval badge to full details: preview container disappears, code/output remain
      await evalHeader.click();
      await expect(evalHeader).toHaveAttribute("aria-expanded", "true");
      await expect(evalBadge.getByTestId("tool-call-preview")).toHaveCount(0);
      await expect(evalBadge.getByTestId("tool-eval-content")).toBeVisible();
      await expect(evalBadge.getByText("def fibonacci(n):")).toBeVisible();
      await expect(evalBadge.getByText("[0, 1, 1, 2, 3, 5, 8, 13]")).toBeVisible();

      // Second click restores preview
      await evalHeader.click();
      await expect(evalHeader).toHaveAttribute("aria-expanded", "false");
      await expect(evalBadge.getByTestId("tool-call-preview")).toBeVisible();

      // 2. Write to notes.txt: content visible without expanding, no escaped JSON
      const notesWriteBadge = page
        .getByTestId("tool-call-badge")
        .filter({ hasText: "notes.txt" })
        .filter({ hasText: "write" });
      await expect(notesWriteBadge).toBeVisible();
      const notesWritePreview = notesWriteBadge.getByTestId("tool-call-preview");
      await expect(notesWritePreview).toBeVisible();
      await expect(
        notesWriteBadge.getByText(
          "Paseo activity previews provide immediate visibility into file operations",
        ),
      ).toBeVisible();
      const notesWriteText = await notesWritePreview.innerText();
      expect(notesWriteText).not.toContain('"filePath":');
      expect(notesWriteText).not.toContain('"content":');

      // 3. Edit notes.txt: old/new diff with added and removed content visible
      const notesEditBadge = page
        .getByTestId("tool-call-badge")
        .filter({ hasText: "notes.txt" })
        .filter({ hasText: "edit" });
      await expect(notesEditBadge).toBeVisible();
      const notesEditPreview = notesEditBadge.getByTestId("tool-call-preview");
      await expect(notesEditPreview).toBeVisible();
      await expect(
        notesEditBadge.getByText("with instant inline previews for quick review"),
      ).toBeVisible();
      await expect(
        notesEditBadge.getByText(
          "without requiring manual expansion of every badge in the timeline",
        ),
      ).toBeVisible();

      await notesWriteBadge.scrollIntoViewIfNeeded();
      await page.screenshot({ path: testInfo.outputPath("file-preview-desktop.png") });
      // 4. Long write to src/preview.ts: clipped in preview, expands to full details, restores on second click
      const previewTsBadge = page
        .getByTestId("tool-call-badge")
        .filter({ hasText: "src/preview.ts" });
      await expect(previewTsBadge).toBeVisible();
      const previewTsHeader = previewTsBadge.locator('[role="button"]').first();
      await expect(previewTsHeader).toHaveAttribute("aria-expanded", "false");

      // In preview: sentinel is clipped, Show more button is visible
      await expect(previewTsBadge.getByTestId("tool-call-preview")).toBeVisible();
      await expect(previewTsBadge.getByText("UNIQUE_PREVIEW_SENTINEL_OK")).not.toBeVisible();
      const showMoreButton = previewTsBadge.getByRole("button", { name: "Show more" });
      await expect(showMoreButton).toBeVisible();

      // Expand to full details by clicking Show more
      await showMoreButton.click();
      await expect(previewTsHeader).toHaveAttribute("aria-expanded", "true");
      await expect(previewTsBadge.getByTestId("tool-call-preview")).toHaveCount(0);
      await expect(previewTsBadge.getByText("UNIQUE_PREVIEW_SENTINEL_OK")).toBeVisible();

      // Second click on header collapses back to preview
      await previewTsHeader.click();
      await expect(previewTsHeader).toHaveAttribute("aria-expanded", "false");
      await expect(previewTsBadge.getByTestId("tool-call-preview")).toBeVisible();
      await expect(previewTsBadge.getByText("UNIQUE_PREVIEW_SENTINEL_OK")).not.toBeVisible();

      // 5. Failed JS eval: explicit error text and code/output visible without expansion
      const failedEvalBadge = page
        .getByTestId("tool-call-badge")
        .filter({ hasText: "Inspect Environment" });
      await expect(failedEvalBadge).toBeVisible();
      const failedEvalHeader = failedEvalBadge.locator('[role="button"]').first();
      await expect(failedEvalHeader).toHaveAttribute("aria-expanded", "false");

      const failedEvalPreview = failedEvalBadge.getByTestId("tool-call-preview");
      await expect(failedEvalPreview).toBeVisible();
      await expect(failedEvalBadge.getByText("unknownEnvironment.getConfig()")).toBeVisible();
      await expect(
        failedEvalBadge.getByText("ReferenceError: unknownEnvironment is not defined").first(),
      ).toBeVisible();
      await expect(
        failedEvalBadge.getByText("ReferenceError: unknownEnvironment is not defined"),
      ).toHaveCount(1);

      // 6. Unrelated unknown and read tools: header-only, no tool-call-preview
      const unknownBadge = page.getByTestId("tool-call-badge").filter({ hasText: "Custom lookup" });
      await expect(unknownBadge).toBeVisible();
      await expect(unknownBadge.getByTestId("tool-call-preview")).toHaveCount(0);

      const readBadge = page.getByTestId("tool-call-badge").filter({ hasText: "package.json" });
      await expect(readBadge).toBeVisible();
      await expect(readBadge.getByTestId("tool-call-preview")).toHaveCount(0);

      // Desktop screenshot attached to testInfo
      await testInfo.attach("tool-call-preview-desktop", {
        body: await page.screenshot({ path: testInfo.outputPath("tool-call-preview-desktop.png") }),
        contentType: "image/png",
      });
    } finally {
      await agent.cleanup();
    }
  });

  test("renders tool call previews in timeline on compact layout and opens details in bottom sheet", async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await configureDetailedToolCalls(page, "light");

    const agent = await seedMockAgentWorkspace({
      repoPrefix: `tool-call-preview-compact-${testInfo.workerIndex}-`,
      title: "Tool call preview compact",
      initialPrompt: "replay tool activity previews",
    });

    try {
      await agent.client.waitForAgentUpsert(
        agent.agentId,
        (snapshot) => snapshot.status === "idle",
        30_000,
      );

      await openAgentRoute(page, agent);
      await expectComposerVisible(page);

      // On compact layout: tool call badges still render preview in timeline
      const evalBadge = page
        .getByTestId("tool-call-badge")
        .filter({ hasText: "Calculate Fibonacci" });
      await expect(evalBadge).toBeVisible({ timeout: 15_000 });
      await expect(evalBadge.getByTestId("tool-call-preview")).toBeVisible();
      await expect(evalBadge.getByText("def fibonacci(n):")).toBeVisible();

      const previewTsBadge = page
        .getByTestId("tool-call-badge")
        .filter({ hasText: "src/preview.ts" });
      await expect(previewTsBadge).toBeVisible();
      await expect(previewTsBadge.getByTestId("tool-call-preview")).toBeVisible();

      // Clicking header opens bottom sheet rather than expanding inline
      const previewTsHeader = previewTsBadge.locator('[role="button"]').first();
      await previewTsHeader.click();

      // Bottom sheet is opened
      const sheetCloseButton = page.getByTestId("tool-call-sheet-close");
      await expect(sheetCloseButton).toBeVisible();

      // Preview remains in the timeline
      await expect(previewTsBadge.getByTestId("tool-call-preview")).toBeVisible();

      // Full content with sentinel is visible inside the sheet
      await expect(page.getByText("UNIQUE_PREVIEW_SENTINEL_OK")).toBeVisible();

      // Close the bottom sheet
      await sheetCloseButton.click();
      await expect(sheetCloseButton).not.toBeVisible();

      // Compact screenshot attached to testInfo
      await testInfo.attach("tool-call-preview-compact", {
        body: await page.screenshot({ path: testInfo.outputPath("tool-call-preview-compact.png") }),
        contentType: "image/png",
      });
    } finally {
      await agent.cleanup();
    }
  });
});
