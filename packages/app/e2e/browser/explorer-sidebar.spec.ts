import { expect, test } from "../support/fixtures";
import { installDaemonWebSocketGate } from "../support/helpers/daemon-websocket-gate";
import { expandFolder, expectExplorerEntryVisible } from "../support/helpers/file-explorer";
import { gotoWorkspace } from "../support/helpers/launcher";
import { seedWorkspace } from "../support/helpers/seed-client";
import {
  ensureExplorerSidebar,
  openFilesPanel,
  waitForWorkspaceTabsVisible,
} from "../support/helpers/workspace-tabs";

const FILE_LISTING_REQUEST = "file_explorer_request";
const FILE_SUBSCRIPTION_REQUEST = "fs.file.subscribe.request";
// Long enough for a retained-but-inactive explorer pane to run the effects that
// used to list directories; a single macrotask would pass on latency alone.
const HIDDEN_SETTLE_MS = 1_000;

function explorerSidebar(page: Parameters<typeof ensureExplorerSidebar>[0]) {
  return page.getByTestId("workspace-explorer-sidebar").filter({ visible: true });
}

test.describe("Explorer sidebar", () => {
  test("starts with Files and Changes, switches views, and toggles without changing main", async ({
    page,
  }) => {
    const workspace = await seedWorkspace({ repoPrefix: "explorer-sidebar-defaults-" });

    try {
      await gotoWorkspace(page, workspace.workspaceId);
      await waitForWorkspaceTabsVisible(page);
      const mainTabsBefore = await page
        .getByTestId("workspace-pane-main")
        .locator('[data-testid^="workspace-tab-"]')
        .count();

      const explorer = await ensureExplorerSidebar(page);
      await expect(explorer.getByTestId("explorer-sidebar-tab-files")).toBeVisible();
      await expect(explorer.getByTestId("explorer-sidebar-tab-changes_tree")).toBeVisible();
      await expect(explorer.getByTestId("workspace-new-tab-button")).toHaveCount(0);

      await openFilesPanel(page);
      await expect(explorer.getByTestId("file-explorer-tree-scroll")).toBeVisible();

      await explorer.getByTestId("explorer-sidebar-tab-changes_tree").click();
      await expect(explorer.getByTestId("changes-tree-panel")).toBeVisible();

      await page.getByTestId("workspace-explorer-toggle").first().click();
      await expect(explorerSidebar(page)).toHaveCount(0);
      await expect(
        page.getByTestId("workspace-pane-main").locator('[data-testid^="workspace-tab-"]'),
      ).toHaveCount(mainTabsBefore);
    } finally {
      await workspace.cleanup();
    }
  });

  test("asks the daemon for no directories until Files is revealed", async ({ page }) => {
    const workspace = await seedWorkspace({
      repoPrefix: "explorer-sidebar-traffic-",
      repo: {
        files: [
          { path: "docs/guide.md", content: "# Guide\n" },
          { path: "src/app.ts", content: "export const app = true;\n" },
        ],
      },
    });
    const gate = await installDaemonWebSocketGate(page);

    try {
      await gotoWorkspace(page, workspace.workspaceId);
      await waitForWorkspaceTabsVisible(page);

      // The workspace tabs only render from a daemon response, so the socket is
      // live while the closed explorer still issues no listing or subscription.
      await page.waitForTimeout(HIDDEN_SETTLE_MS);
      expect(gate.getClientRequestCount(FILE_LISTING_REQUEST)).toBe(0);
      expect(gate.getClientRequestCount(FILE_SUBSCRIPTION_REQUEST)).toBe(0);

      // Opening on Changes retains the Files tab mounted without activating it.
      const explorer = await ensureExplorerSidebar(page);
      await expect(explorer.getByTestId("changes-tree-panel")).toBeVisible();
      await page.waitForTimeout(HIDDEN_SETTLE_MS);
      expect(gate.getClientRequestCount(FILE_LISTING_REQUEST)).toBe(0);
      expect(gate.getClientRequestCount(FILE_SUBSCRIPTION_REQUEST)).toBe(0);

      await openFilesPanel(page);
      await expect.poll(() => gate.getClientRequestCount(FILE_LISTING_REQUEST)).toBeGreaterThan(0);
      await expandFolder(page, "docs");
      await expectExplorerEntryVisible(page, "guide.md");
      const listingCountAfterRevealAndExpand = gate.getClientRequestCount(FILE_LISTING_REQUEST);

      // Hiding keeps the retained rows untouched: no further listing work runs.
      await page.getByTestId("workspace-explorer-toggle").first().click();
      await expect(explorerSidebar(page)).toHaveCount(0);
      await page.waitForTimeout(HIDDEN_SETTLE_MS);
      expect(gate.getClientRequestCount(FILE_LISTING_REQUEST)).toBe(
        listingCountAfterRevealAndExpand,
      );

      // Reopening restores the Files view with the expanded folder intact.
      await page.getByTestId("workspace-explorer-toggle").first().click();
      await expect(explorer.getByTestId("file-explorer-tree-scroll")).toBeVisible();
      await expectExplorerEntryVisible(page, "guide.md");
      await expectExplorerEntryVisible(page, "src");
    } finally {
      gate.restore();
      await workspace.cleanup();
    }
  });
});
