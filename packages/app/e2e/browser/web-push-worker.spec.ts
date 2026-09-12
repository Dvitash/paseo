import type { Page } from "@playwright/test";
import { expect, test } from "../support/fixtures";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";
import { getServerId } from "../support/helpers/server-id";
import { openHostSection } from "../support/helpers/settings";
import { buildNotificationRoute } from "../../src/utils/notification-routing";

// Headless Shell hard-denies notifications; full Chromium exercises the real permission API.
test.use({ channel: "chromium" });

async function readNotifications(page: Page, scope: string) {
  return page.evaluate(async (workerScope) => {
    const registration = await navigator.serviceWorker.getRegistration(workerScope);
    const notifications = await registration?.getNotifications();
    return notifications?.map((notification) => ({
      title: notification.title,
      body: notification.body,
      url: notification.data.url,
    }));
  }, scope);
}

test("the push worker displays notifications with the app closed and preserves safe chat targets", async ({
  context,
  page,
}, testInfo) => {
  const workspace = await seedMockAgentWorkspace({
    repoPrefix: "web-push-worker-",
    title: "Background push target",
  });
  const serverId = getServerId();
  const scope = `/_paseo/push/${encodeURIComponent(serverId)}/`;
  try {
    await context.grantPermissions(["notifications"]);
    await openAgentRoute(page, workspace);
    const origin = new URL(page.url()).origin;
    expect(await page.evaluate(() => Notification.permission)).toBe("granted");
    await page.goto(`${origin}/settings/hosts/${encodeURIComponent(serverId)}`);
    await openHostSection(page, serverId, "host");
    const settings = page.getByTestId("web-push-section");
    await expect(settings).toBeVisible();
    await expect(page.getByTestId("web-push-enable-button")).toBeVisible();
    await settings.screenshot({ path: testInfo.outputPath("web-push-settings.png") });
    await context.grantPermissions([], { origin });
    await page.reload();
    await expect(settings).toContainText("Notification permission was blocked");
    await expect(page.getByTestId("web-push-enable-button")).toHaveCount(0);
    await context.grantPermissions(["notifications"], { origin });
    await page.reload();
    await expect(page.getByTestId("web-push-enable-button")).toBeVisible();
    // This observer has no app code or daemon connection. The actual app page is closed below.
    const observer = await context.newPage();
    await observer.goto(`${origin}/manifest.json`);
    const cdp = await context.newCDPSession(observer);
    const registrationId = new Promise<string>((resolve) => {
      cdp.on("ServiceWorker.workerRegistrationUpdated", ({ registrations }) => {
        const registration = registrations.find(
          (entry) => entry.scopeURL === `${origin}${scope}` && !entry.isDeleted,
        );
        if (registration) resolve(registration.registrationId);
      });
    });
    await cdp.send("ServiceWorker.enable");
    await page.evaluate(async (workerScope) => {
      await navigator.serviceWorker.register("/push-service-worker.js", {
        scope: workerScope,
        updateViaCache: "none",
      });
    }, scope);
    await expect
      .poll(() =>
        page.evaluate(async (workerScope) => {
          const registration = await navigator.serviceWorker.getRegistration(workerScope);
          return registration?.active?.state;
        }, scope),
      )
      .toBe("activated");
    const workerRegistrationId = await registrationId;
    await page.close();

    const target = { serverId, workspaceId: workspace.workspaceId, agentId: workspace.agentId };
    await cdp.send("ServiceWorker.deliverPushMessage", {
      origin,
      registrationId: workerRegistrationId,
      data: JSON.stringify({
        title: "Agent finished",
        body: "Your background task is ready.",
        data: { ...target, serverId: "untrusted-other-host", url: "https://example.com/" },
      }),
    });
    await expect
      .poll(() => readNotifications(observer, scope))
      .toEqual([
        {
          title: "Agent finished",
          body: "Your background task is ready.",
          url: buildNotificationRoute(target),
        },
      ]);

    // Notification permission survives worker restarts; no live page is needed to display again.
    await observer.evaluate(async (workerScope) => {
      const registration = await navigator.serviceWorker.getRegistration(workerScope);
      for (const notification of (await registration?.getNotifications()) ?? []) {
        notification.close();
      }
    }, scope);
    await cdp.send("ServiceWorker.stopAllWorkers");
    await cdp.send("ServiceWorker.deliverPushMessage", {
      origin,
      registrationId: workerRegistrationId,
      data: "not json",
    });
    await expect
      .poll(() => readNotifications(observer, scope))
      .toEqual([
        {
          title: "Paseo",
          body: "An agent needs your attention.",
          url: buildNotificationRoute({ serverId }),
        },
      ]);
  } finally {
    await workspace.cleanup();
  }
});
