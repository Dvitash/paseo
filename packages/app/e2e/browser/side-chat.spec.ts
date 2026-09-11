import { expect, test } from "../support/fixtures";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";
import {
  ensureExplorerSidebar,
  waitForWorkspaceTabsVisible,
} from "../support/helpers/workspace-tabs";

test("Side is enabled by default and retains its conversation when reopened", async ({
  page,
}, testInfo) => {
  const workspace = await seedMockAgentWorkspace({
    repoPrefix: "side-chat-",
    title: "Main context",
    model: "ten-second-stream",
  });
  try {
    await openAgentRoute(page, workspace);
    await waitForWorkspaceTabsVisible(page);
    const sidebar = await ensureExplorerSidebar(page);
    // Electron routes right-clicks on drag regions to the OS window menu instead.
    await expect(sidebar.getByTestId("explorer-sidebar-tab-rail")).toHaveCSS(
      "-webkit-app-region",
      "no-drag",
    );
    const sideTab = sidebar.getByRole("button", {
      name: "Side chat linked to active agent",
      exact: true,
    });
    await expect(sideTab).toBeVisible();
    await sideTab.click();
    const toggleSideTab = async () => {
      await sidebar.getByTestId("explorer-sidebar-tab-rail").click({
        button: "right",
        position: { x: 20, y: 2 },
      });
      await page
        .getByTestId("explorer-sidebar-tab-configuration")
        .getByRole("menuitem", { name: "Side", exact: true })
        .click();
    };
    const side = sidebar.getByTestId("side-chat-view");
    await expect(side.getByTestId("side-panel-linked-header")).toContainText("Main context");
    await expect(side.getByTestId("side-send-button")).toBeDisabled();
    const input = side.getByTestId("side-input");
    await input.press("Enter");
    await expect(input).toHaveValue("");
    await input.fill("First line");
    await input.press("Shift+Enter");
    await input.press("End");
    await input.type("Second line");
    await expect(input).toHaveValue("First line\nSecond line");
    await expect(side.getByTestId("side-running-indicator")).not.toBeVisible();
    await side
      .getByTestId("side-input")
      .fill("Explain the current session without changing anything.");
    await expect(side.getByTestId("side-send-button")).toBeEnabled();
    await input.press("Enter");
    await expect(side.getByTestId("side-running-indicator")).toBeVisible();
    await expect(side.locator('[data-testid^="side-message-assistant-"]')).toContainText("Cycle 1");
    await testInfo.attach("side-streaming", {
      body: await page.screenshot({ path: testInfo.outputPath("side-streaming.png") }),
      contentType: "image/png",
    });
    await side.getByTestId("side-stop-button").click();
    await expect(side.getByTestId("side-running-indicator")).not.toBeVisible();
    await expect(side.getByTestId("side-error-banner")).not.toBeVisible();
    await toggleSideTab();
    await expect(sideTab).not.toBeVisible();
    await page.reload({ waitUntil: "commit" });
    await ensureExplorerSidebar(page);
    await expect(sideTab).not.toBeVisible();
    await toggleSideTab();
    await expect(sideTab).toBeVisible();
    await page.getByTestId("workspace-explorer-toggle").first().click();
    await expect(side).not.toBeVisible();
    await ensureExplorerSidebar(page);
    await expect(
      side.getByText("Explain the current session without changing anything.", { exact: true }),
    ).toBeVisible();
    await page.reload({ waitUntil: "commit" });
    await ensureExplorerSidebar(page);
    await expect(
      page
        .getByTestId("side-chat-view")
        .getByText("Explain the current session without changing anything.", { exact: true }),
    ).toBeVisible();
    await expect(page.getByTestId(`workspace-tab-agent_${workspace.agentId}`)).toBeVisible();
    const restoredSide = page.getByTestId("side-chat-view");
    await restoredSide.getByTestId("side-input").fill("emit synthetic turn failure");
    await restoredSide.getByTestId("side-send-button").click();
    await expect(restoredSide.getByTestId("side-error-banner")).toContainText(
      "Requested mock provider failure",
    );
  } finally {
    await workspace.cleanup();
  }
});

test("Side status button sends the fixed prompt and preserves a typed draft", async ({ page }) => {
  const workspace = await seedMockAgentWorkspace({
    repoPrefix: "side-chat-status-",
    title: "Status main context",
    model: "ten-second-stream",
  });
  try {
    await openAgentRoute(page, workspace);
    await waitForWorkspaceTabsVisible(page);
    const sidebar = await ensureExplorerSidebar(page);
    const sideTab = sidebar.getByRole("button", {
      name: "Side chat linked to active agent",
      exact: true,
    });
    await expect(sideTab).toBeVisible();
    await sideTab.click();

    const side = sidebar.getByTestId("side-chat-view");
    await expect(side.getByTestId("side-panel-linked-header")).toContainText("Status main context");

    const input = side.getByTestId("side-input");
    await input.fill("draft I am still writing");
    await side.getByTestId("side-status-button").click();

    await expect(
      side.getByText(
        "Give me a status update on the main agent: what it is doing right now, what it just did, and what is next.",
        { exact: true },
      ),
    ).toBeVisible();
    await expect(side.getByTestId("side-running-indicator")).toBeVisible();
    // The quick action must not consume the in-progress draft.
    await expect(input).toHaveValue("draft I am still writing");

    await side.getByTestId("side-stop-button").click();
    await expect(side.getByTestId("side-running-indicator")).not.toBeVisible();
  } finally {
    await workspace.cleanup();
  }
});

test("Side is available in the compact Explorer and stays linked when reopened", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const workspace = await seedMockAgentWorkspace({
    repoPrefix: "side-chat-compact-",
    title: "Mobile main context",
  });
  try {
    await openAgentRoute(page, workspace);
    await page.getByTestId("workspace-explorer-toggle").filter({ visible: true }).click();
    const sideTab = page.getByTestId("explorer-tab-side");
    await expect(sideTab).toBeVisible();
    await sideTab.click();
    const side = page.getByTestId("side-chat-view");
    await expect(side.getByTestId("side-panel-linked-header")).toContainText("Mobile main context");
    await side.getByTestId("side-input").fill("Explain this session.");
    await side.getByTestId("side-send-button").click();
    await expect(side.locator('[data-testid^="side-message-assistant-"]')).toContainText("Cycle 1");
    await page.getByTestId("explorer-close").click();
    await expect(side).not.toBeVisible();
    await page.getByTestId("workspace-explorer-toggle").filter({ visible: true }).click();
    await expect(side.getByText("Explain this session.", { exact: true })).toBeVisible();
    await expect(side.getByTestId("side-panel-linked-header")).toContainText("Mobile main context");
  } finally {
    await workspace.cleanup();
  }
});
