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

      // Verify reference error is still shown only once when expanded
      await failedEvalHeader.click();
      await expect(failedEvalHeader).toHaveAttribute("aria-expanded", "true");
      await expect(
        failedEvalBadge.getByText("ReferenceError: unknownEnvironment is not defined"),
      ).toHaveCount(1);
      await failedEvalHeader.click();
      await expect(failedEvalHeader).toHaveAttribute("aria-expanded", "false");

      // 6. One-line JS eval failure with wrapped JSON envelope error and long unbroken token
      const doubleCoinsBadge = page
        .getByTestId("tool-call-badge")
        .filter({ hasText: "Process DoubleCoins Purchase" });
      await expect(doubleCoinsBadge).toBeVisible();
      const doubleCoinsHeader = doubleCoinsBadge.locator('[role="button"]').first();
      await expect(doubleCoinsHeader).toHaveAttribute("aria-expanded", "false");

      // A. Actionable error visible in tool-eval-error without expanding, no raw envelope wrappers or stack
      const evalErrorPreview = doubleCoinsBadge.getByTestId("tool-eval-error");
      await expect(evalErrorPreview).toBeVisible();
      await expect(evalErrorPreview).toContainText("Paid pass: DoubleCoins");
      const previewErrorText = await evalErrorPreview.innerText();
      expect(previewErrorText).not.toContain('"content":');
      expect(previewErrorText).not.toContain('"ok":');
      expect(previewErrorText).not.toContain('{"ok":false');
      expect(previewErrorText).not.toContain('"bridge":');
      expect(previewErrorText).not.toContain("js-cell-example.js:6:16");

      // B. Code is formatted into multiple logical lines while preserving string tokens
      const previewCodeBlock = doubleCoinsBadge.getByTestId("tool-eval-code").first();
      await expect(previewCodeBlock).toBeVisible();
      await expect
        .poll(async () => (await previewCodeBlock.innerText()).split("\n").filter(Boolean).length)
        .toBeGreaterThanOrEqual(5);
      const previewCodeText = await previewCodeBlock.innerText();
      const previewCodeLines = previewCodeText
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
      expect(previewCodeLines.length).toBeGreaterThanOrEqual(5);
      expect(previewCodeText).toContain("function verifyTransaction(receipt)");
      expect(previewCodeText).toContain(
        "PASEO_TX_TOKEN_UNBROKEN_LONG_SECRET_IDENTIFIER_STRING_0123456789_ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz",
      );

      // C. Formatted source clipped preview: sentinel at line 23 is NOT visible in preview (clipped after 8 lines)
      expect(previewCodeText).not.toContain("COMPLETED_EVAL_SENTINEL_OUTPUT_END");
      await expect(
        doubleCoinsBadge.getByText("COMPLETED_EVAL_SENTINEL_OUTPUT_END"),
      ).not.toBeVisible();

      // D. Test visual long-line wrapping using measured DOM width/scrollWidth and bounding rects
      const codeContainerBox = await previewCodeBlock.boundingBox();
      expect(codeContainerBox).not.toBeNull();
      const previewWrappingMetrics = await previewCodeBlock.evaluate((el) => ({
        scrollWidth: el.scrollWidth,
        clientWidth: el.clientWidth,
      }));
      expect(previewWrappingMetrics.scrollWidth).toBeLessThanOrEqual(
        previewWrappingMetrics.clientWidth + 4,
      );

      const longTokenElement = doubleCoinsBadge.getByText(
        /PASEO_TX_TOKEN_UNBROKEN_LONG_SECRET_IDENTIFIER_STRING/,
      );
      await expect(longTokenElement).toBeVisible();
      const longTokenBox = await longTokenElement.boundingBox();
      expect(longTokenBox).not.toBeNull();
      expect(longTokenBox!.width).toBeLessThanOrEqual(codeContainerBox!.width + 4);

      // E. Expand badge to full details: clipped preview expands fully and full error exposes stack info
      await doubleCoinsHeader.click();
      await expect(doubleCoinsHeader).toHaveAttribute("aria-expanded", "true");
      await expect(doubleCoinsBadge.getByTestId("tool-call-preview")).toHaveCount(0);

      // Full code is visible including the end sentinel
      await expect(doubleCoinsBadge.getByText("COMPLETED_EVAL_SENTINEL_OUTPUT_END")).toBeVisible();

      // Full error exposes original stack information
      const expandedError = doubleCoinsBadge.getByTestId("tool-eval-error");
      await expect(expandedError).toBeVisible();
      await expect(expandedError).toContainText("Paid pass: DoubleCoins");
      await expect(expandedError).toContainText("js-cell-example.js:6:16");
      const expandedErrorText = await expandedError.innerText();
      expect(expandedErrorText).not.toContain('"content":');
      expect(expandedErrorText).not.toContain('{"ok":false');

      // Visual wrapping in expanded view
      const expandedCodeBlock = doubleCoinsBadge.getByTestId("tool-eval-code").first();
      await expect(expandedCodeBlock).toBeVisible();
      const expandedWrappingMetrics = await expandedCodeBlock.evaluate((el) => ({
        scrollWidth: el.scrollWidth,
        clientWidth: el.clientWidth,
      }));
      expect(expandedWrappingMetrics.scrollWidth).toBeLessThanOrEqual(
        expandedWrappingMetrics.clientWidth + 4,
      );

      // Capture desktop screenshot of the expanded failure and code
      await doubleCoinsBadge.scrollIntoViewIfNeeded();
      await page.screenshot({ path: testInfo.outputPath("double-coins-eval-desktop.png") });
      await testInfo.attach("double-coins-eval-desktop", {
        body: await page.screenshot({ path: testInfo.outputPath("double-coins-eval-desktop.png") }),
        contentType: "image/png",
      });

      // Restore to preview state
      await doubleCoinsHeader.click();
      await expect(doubleCoinsHeader).toHaveAttribute("aria-expanded", "false");
      await expect(doubleCoinsBadge.getByTestId("tool-call-preview")).toBeVisible();

      // 7. Unrelated unknown and read tools: header-only, no tool-call-preview
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

      // Existing failed JS eval (Inspect Environment) reference error shown once on compact
      const compactFailedEvalBadge = page
        .getByTestId("tool-call-badge")
        .filter({ hasText: "Inspect Environment" });
      await expect(compactFailedEvalBadge).toBeVisible();
      await expect(
        compactFailedEvalBadge.getByText("ReferenceError: unknownEnvironment is not defined"),
      ).toHaveCount(1);

      // Failed one-line JS eval with wrapped error on compact layout (390px viewport)
      const compactDoubleCoinsBadge = page
        .getByTestId("tool-call-badge")
        .filter({ hasText: "Process DoubleCoins Purchase" });
      await expect(compactDoubleCoinsBadge).toBeVisible();
      await expect(compactDoubleCoinsBadge.getByTestId("tool-call-preview")).toBeVisible();

      // Timeline preview shows actionable error without expanding and no raw JSON wrappers
      const compactError = compactDoubleCoinsBadge.getByTestId("tool-eval-error");
      await expect(compactError).toBeVisible();
      await expect(compactError).toContainText("Paid pass: DoubleCoins");
      const compactErrorText = await compactError.innerText();
      expect(compactErrorText).not.toContain('"content":');
      expect(compactErrorText).not.toContain('"ok":');
      expect(compactErrorText).not.toContain('{"ok":false');
      expect(compactErrorText).not.toContain("js-cell-example.js:6:16");

      // Code is formatted into multiple logical lines while preserving string tokens
      const compactCodeBlock = compactDoubleCoinsBadge.getByTestId("tool-eval-code").first();
      await expect(compactCodeBlock).toBeVisible();
      await expect
        .poll(async () => (await compactCodeBlock.innerText()).split("\n").filter(Boolean).length)
        .toBeGreaterThanOrEqual(5);
      const compactCodeText = await compactCodeBlock.innerText();
      const compactCodeLines = compactCodeText
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
      expect(compactCodeLines.length).toBeGreaterThanOrEqual(5);
      expect(compactCodeText).toContain("function verifyTransaction(receipt)");
      expect(compactCodeText).toContain(
        "PASEO_TX_TOKEN_UNBROKEN_LONG_SECRET_IDENTIFIER_STRING_0123456789_ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz",
      );

      // Sentinel is clipped in timeline preview
      expect(compactCodeText).not.toContain("COMPLETED_EVAL_SENTINEL_OUTPUT_END");
      await expect(
        compactDoubleCoinsBadge.getByText("COMPLETED_EVAL_SENTINEL_OUTPUT_END"),
      ).not.toBeVisible();

      // Visual long-line wrapping on narrow compact layout (390px viewport)
      const compactCodeBox = await compactCodeBlock.boundingBox();
      expect(compactCodeBox).not.toBeNull();
      const compactMetrics = await compactCodeBlock.evaluate((el) => ({
        scrollWidth: el.scrollWidth,
        clientWidth: el.clientWidth,
      }));
      expect(compactMetrics.scrollWidth).toBeLessThanOrEqual(compactMetrics.clientWidth + 4);

      const compactTokenEl = compactDoubleCoinsBadge.getByText(
        /PASEO_TX_TOKEN_UNBROKEN_LONG_SECRET_IDENTIFIER_STRING/,
      );
      await expect(compactTokenEl).toBeVisible();
      const compactTokenBox = await compactTokenEl.boundingBox();
      expect(compactTokenBox).not.toBeNull();
      expect(compactTokenBox!.width).toBeLessThanOrEqual(compactCodeBox!.width + 4);

      // Clicking header opens bottom sheet on compact layout
      const compactHeader = compactDoubleCoinsBadge.locator('[role="button"]').first();
      await compactHeader.click();

      // Bottom sheet is opened
      const doubleCoinsSheetClose = page.getByTestId("tool-call-sheet-close");
      await expect(doubleCoinsSheetClose).toBeVisible();

      // Full code expands in bottom sheet with end sentinel visible
      await expect(page.getByText("COMPLETED_EVAL_SENTINEL_OUTPUT_END")).toBeVisible();

      // Full error exposes stack info inside bottom sheet
      const sheetError = page.getByTestId("tool-eval-error").last();
      await expect(sheetError).toBeVisible();
      await expect(sheetError).toContainText("Paid pass: DoubleCoins");
      await expect(sheetError).toContainText("js-cell-example.js:6:16");
      const sheetErrorText = await sheetError.innerText();
      expect(sheetErrorText).not.toContain('"content":');
      expect(sheetErrorText).not.toContain('{"ok":false');

      // Visual wrapping inside sheet
      const sheetCodeBlock = page.getByTestId("tool-eval-code").last();
      await expect(sheetCodeBlock).toBeVisible();
      const sheetMetrics = await sheetCodeBlock.evaluate((el) => ({
        scrollWidth: el.scrollWidth,
        clientWidth: el.clientWidth,
      }));
      expect(sheetMetrics.scrollWidth).toBeLessThanOrEqual(sheetMetrics.clientWidth + 4);

      // Capture compact screenshot before closing sheet
      await page.screenshot({ path: testInfo.outputPath("double-coins-eval-compact.png") });
      await testInfo.attach("double-coins-eval-compact", {
        body: await page.screenshot({ path: testInfo.outputPath("double-coins-eval-compact.png") }),
        contentType: "image/png",
      });

      // Close bottom sheet
      await doubleCoinsSheetClose.click();
      await expect(doubleCoinsSheetClose).not.toBeVisible();

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
