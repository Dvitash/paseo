import { existsSync } from "node:fs";
import path from "node:path";
import { expect, test } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import {
  archiveWorkspaceFromDaemon,
  connectNewWorkspaceDaemonClient,
  createWorktreeViaDaemon,
  type OpenedProject,
} from "../support/helpers/new-workspace";
import { seedWorkspace } from "../support/helpers/seed-client";
import { getServerId } from "../support/helpers/server-id";
import { waitForWorkspaceInSidebar } from "../support/helpers/workspace-ui";
import {
  closeDesktopTab,
  DESKTOP_TAB_TEST_ID,
  observeDesktopEvents,
  runDesktopCommand,
  setupWorktreeDesktopPlugin,
  WORKTREE_DESKTOP_PLUGIN_ID,
} from "../support/helpers/worktree-desktop";

test.setTimeout(180_000);

test("proves readiness gating, auto-open, iframe permissions, deduplication, and recovery", async ({
  page,
}, testInfo) => {
  const daemonClient = await connectNewWorkspaceDaemonClient({ ownProjects: false });
  const previousConfig = await daemonClient.getDaemonConfig();
  const previousPluginsEnabled = previousConfig.config.pluginsEnabled ?? false;
  const primary = await seedWorkspace({ repoPrefix: "worktree-desktop-primary-" });
  const plugin = await setupWorktreeDesktopPlugin({
    startupTimeoutMs: 6000,
    pollIntervalMs: 200,
  });

  const createdWorktrees: OpenedProject[] = [];

  try {
    await daemonClient.patchDaemonConfig({ pluginsEnabled: true });
    await daemonClient.installDirectoryPlugin(plugin.directory);

    const eventsObserver = observeDesktopEvents(page);

    await test.step("initial plugin load does not open Desktop before worktree lifecycle", async () => {
      await gotoAppShell(page);
      await waitForWorkspaceInSidebar(page, {
        serverId: getServerId(),
        workspaceId: primary.workspaceId,
      });

      // Wait >=2 polls to establish baseline before creating worktree
      await eventsObserver.waitForPolls(2);

      await expect(page.locator("iframe[title='Worktree Desktop']")).toHaveCount(0);
      await expect(page.getByTestId(DESKTOP_TAB_TEST_ID)).toHaveCount(0);
    });

    const worktreeSlug1 = `wt-auto-${Date.now()}`;

    await test.step("daemon creates worktree; readiness gates auto-open upon HTTP 200", async () => {
      const worktree1 = await createWorktreeViaDaemon(daemonClient, {
        cwd: primary.repoPath,
        slug: worktreeSlug1,
      });
      createdWorktrees.push(worktree1);

      // Verify child process adapter wrote state.json on disk
      const stateFile = path.join(plugin.baseDir, worktreeSlug1, "state.json");
      await expect.poll(async () => existsSync(stateFile), { timeout: 20_000 }).toBe(true);

      // While stream returns 503, no desktop tab is mounted
      await expect(page.locator("iframe[title='Worktree Desktop']")).toHaveCount(0);
      await expect(page.getByTestId(DESKTOP_TAB_TEST_ID)).toHaveCount(0);

      // Release HTTP 200 BEFORE timeout (timeout is 6000ms) to prove auto-open
      plugin.release200();

      // Desktop tab auto-opens upon probe HTTP 200 without manual intervention
      const desktopTab = page.getByTestId(DESKTOP_TAB_TEST_ID);
      await expect(desktopTab).toBeVisible({ timeout: 25_000 });
      await expect(desktopTab).toHaveAttribute("aria-selected", "true");

      // Verify route settled on the worktree workspace
      expect(page.url()).toContain(worktree1.workspaceId);
    });

    await test.step("renders exactly one desktop tab + iframe with exact URL and sandbox properties", async () => {
      await expect(page.getByTestId(DESKTOP_TAB_TEST_ID)).toHaveCount(1);

      const iframe = page.locator("iframe[title='Worktree Desktop']");
      await expect(iframe).toHaveCount(1);
      await expect(iframe).toHaveAttribute("src", plugin.fixtureUrl);
      await expect(iframe).toHaveAttribute(
        "allow",
        "autoplay; fullscreen; clipboard-read; clipboard-write",
      );
      await expect(iframe).toHaveAttribute(
        "sandbox",
        "allow-scripts allow-same-origin allow-forms allow-downloads allow-pointer-lock allow-popups",
      );
      await expect(iframe).toHaveAttribute("referrerpolicy", "no-referrer");

      // Viewport remains un-fullscreened
      const hasFullscreen = await page.evaluate(() => Boolean(document.fullscreenElement));
      expect(hasFullscreen).toBe(false);

      await testInfo.attach("01-desktop-ready-iframe", {
        body: await page.screenshot({ path: testInfo.outputPath("01-desktop-ready-iframe.png") }),
        contentType: "image/png",
      });
    });

    await test.step("interacts with HTML inside iframe using Playwright", async () => {
      const frame = page.frameLocator("iframe[title='Worktree Desktop']");
      await expect(frame.getByTestId("desktop-heading")).toHaveText("Worktree Desktop Ready");

      const input = frame.getByTestId("desktop-input");
      await input.fill("desktop-auto-open-command");

      const submitBtn = frame.getByTestId("desktop-button");
      await submitBtn.click();

      const output = frame.getByTestId("desktop-output");
      await expect(output).toHaveText("desktop-auto-open-command");

      await page.getByRole("button", { name: "Reload", exact: true }).click();
      await expect(output).toHaveText("");
      await expect(page.locator("iframe[title='Worktree Desktop']")).toHaveCount(1);
    });

    await test.step("inactive tabs pause viewer and reopening via command center dedupes", async () => {
      await page.getByTestId("workspace-new-tab-button").filter({ visible: true }).first().click();
      await page.getByTestId("workspace-new-tab-menu-agent").filter({ visible: true }).click();

      // When tab is hidden, retained parent pauses viewer and unmounts primary iframe
      await expect(page.locator("iframe[title='Worktree Desktop']")).toHaveCount(0);

      // Selecting Desktop restores the frame without duplicate frames
      const desktopTab = page.getByTestId(DESKTOP_TAB_TEST_ID);
      await desktopTab.click();
      await expect(desktopTab).toHaveAttribute("aria-selected", "true");
      await expect(page.locator("iframe[title='Worktree Desktop']")).toHaveCount(1);

      // Reopening from Command Center dedupes existing desktop panel
      await runDesktopCommand(page, "Open desktop");
      await expect(page.getByTestId(DESKTOP_TAB_TEST_ID)).toHaveCount(1);
      await expect(page.locator("iframe[title='Worktree Desktop']")).toHaveCount(1);
    });

    await test.step("closing tab and reloading PWA does not auto-reopen historical desktop", async () => {
      await closeDesktopTab(page);
      await expect(page.getByTestId(DESKTOP_TAB_TEST_ID)).toHaveCount(0);
      await expect(page.locator("iframe[title='Worktree Desktop']")).toHaveCount(0);

      const baselinePolls = eventsObserver.pollCount;
      await page.reload();
      await waitForWorkspaceInSidebar(page, {
        serverId: getServerId(),
        workspaceId: primary.workspaceId,
      });

      // Wait >=2 baseline polls to verify client automation establishes cursor without replay
      await eventsObserver.waitForPolls(baselinePolls + 2);

      await expect(page.getByTestId(DESKTOP_TAB_TEST_ID)).toHaveCount(0);
      await expect(page.locator("iframe[title='Worktree Desktop']")).toHaveCount(0);

      await testInfo.attach("02-desktop-closed-and-reloaded", {
        body: await page.screenshot({
          path: testInfo.outputPath("02-desktop-closed-and-reloaded.png"),
        }),
        contentType: "image/png",
      });
    });

    await test.step("startup timeout produces visible actionable error with retry", async () => {
      // Set fixture server back to 503 to test timeout error handling
      plugin.set503();

      const worktreeSlug2 = `wt-retry-${Date.now()}`;
      const worktree2 = await createWorktreeViaDaemon(daemonClient, {
        cwd: primary.repoPath,
        slug: worktreeSlug2,
      });
      createdWorktrees.push(worktree2);

      const stateFile2 = path.join(plugin.baseDir, worktreeSlug2, "state.json");
      await expect.poll(async () => existsSync(stateFile2), { timeout: 20_000 }).toBe(true);

      // After startup timeout (6000ms) with stream unready, lifecycle publishes error event
      await expect(page.getByText("Desktop startup error")).toBeVisible({ timeout: 25_000 });
      await expect(page.getByText(/become ready/i)).toBeVisible();

      const retryButton = page.getByRole("button", { name: "Retry", exact: true });
      await expect(retryButton).toBeVisible();

      await testInfo.attach("03-desktop-startup-error", {
        body: await page.screenshot({ path: testInfo.outputPath("03-desktop-startup-error.png") }),
        contentType: "image/png",
      });

      // Release HTTP 200 and recover on Retry
      plugin.release200();
      await retryButton.click();

      const desktopTab2 = page.getByTestId(DESKTOP_TAB_TEST_ID);
      await expect(desktopTab2).toBeVisible({ timeout: 25_000 });
      await expect(desktopTab2).toHaveAttribute("aria-selected", "true");
      await expect(page.locator("iframe[title='Worktree Desktop']")).toHaveCount(1);
    });
  } finally {
    await daemonClient.removePlugin(WORKTREE_DESKTOP_PLUGIN_ID).catch(() => undefined);
    await daemonClient
      .patchDaemonConfig({ pluginsEnabled: previousPluginsEnabled })
      .catch(() => undefined);

    for (const wt of createdWorktrees) {
      await archiveWorkspaceFromDaemon(daemonClient, wt.workspaceDirectory).catch(() => undefined);
    }

    await daemonClient.close().catch(() => undefined);
    await primary.cleanup().catch(() => undefined);
    await plugin.cleanup().catch(() => undefined);
  }
});
