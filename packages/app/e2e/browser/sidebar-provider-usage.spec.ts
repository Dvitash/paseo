import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test as base } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";

const test = base.extend<{}, { usageCachePath: string }>({
  usageCachePath: [
    // Playwright inspects the destructuring pattern to discover fixture dependencies.
    // eslint-disable-next-line no-empty-pattern
    async ({}, provide) => {
      const directory = await mkdtemp(join(tmpdir(), "paseo-sidebar-usage-"));
      try {
        await provide(join(directory, "usage-cache.json"));
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
    { scope: "worker" },
  ],
  e2eDaemonEnvironment: [
    async ({ usageCachePath }, provide) => {
      await provide({ PASEO_OMP_USAGE_CACHE_PATH: usageCachePath });
    },
    { scope: "worker" },
  ],
});

interface UsageAccount {
  provider: string;
  usedFraction: number;
}

async function writeUsageCache(
  path: string,
  accounts: UsageAccount[],
  now = Date.now(),
): Promise<void> {
  const reports = accounts.map(({ provider, usedFraction }) => ({
    provider,
    fetchedAt: now,
    limits: [
      {
        id: `${provider}:weekly`,
        window: { id: "weekly", label: "Weekly", durationMs: 604800000 },
        amount: { usedFraction, remainingFraction: 1 - usedFraction },
        status: "ok",
      },
    ],
  }));
  await writeFile(path, JSON.stringify({ generatedAt: now, reports }));
}

test("shows systemd-cache usage above the matching footer and redistributes providers", async ({
  page,
  usageCachePath,
}, testInfo) => {
  test.setTimeout(120_000);
  await writeUsageCache(usageCachePath, [
    { provider: "anthropic", usedFraction: 0.5 },
    { provider: "openai-codex", usedFraction: 0.74 },
  ]);
  await gotoAppShell(page);

  const bar = page.getByTestId("sidebar-provider-usage");
  const footer = page.getByTestId("sidebar-footer");
  await expect(bar).toBeVisible();
  await expect(bar.getByTestId("sidebar-provider-usage-anthropic")).toContainText("50%");
  await expect(bar.getByTestId("sidebar-provider-usage-openai-codex")).toContainText("26%");
  await expect(bar.locator("svg")).toHaveCount(2);
  const barBounds = await bar.boundingBox();
  const footerBounds = await footer.boundingBox();
  if (!barBounds || !footerBounds) throw new Error("Sidebar footer geometry unavailable");
  expect(barBounds.height).toBe(footerBounds.height);
  expect(barBounds.y + barBounds.height).toBeCloseTo(footerBounds.y, 0);
  await bar.screenshot({ path: testInfo.outputPath("provider-usage-two.png") });

  await writeUsageCache(usageCachePath, [
    { provider: "google-antigravity", usedFraction: 0.2 },
    { provider: "openai-codex", usedFraction: 0.3 },
    { provider: "opencode-go", usedFraction: 0.4 },
    { provider: "cursor", usedFraction: 0.5 },
    { provider: "devin", usedFraction: 0.6 },
  ]);
  await page.reload();
  await expect(bar.getByTestId("sidebar-provider-usage-devin")).toContainText("40%");
  const slots = bar.locator('[data-testid^="sidebar-provider-usage-"]');
  await expect(slots).toHaveCount(5);
  await expect(bar.locator("svg")).toHaveCount(5);
  const geometry = await slots.evaluateAll((elements) =>
    elements.map((element) => {
      const bounds = element.getBoundingClientRect();
      return { x: bounds.x, right: bounds.right, width: bounds.width };
    }),
  );
  for (let index = 1; index < geometry.length; index += 1) {
    expect(geometry[index].x).toBeGreaterThanOrEqual(geometry[index - 1].right - 1);
    expect(geometry[index].width).toBeCloseTo(geometry[0].width, 0);
  }
  await bar.screenshot({ path: testInfo.outputPath("provider-usage-five.png") });

  await writeUsageCache(usageCachePath, [{ provider: "openai-codex", usedFraction: 0 }]);
  await page.reload();
  await expect(slots).toHaveCount(1);
  await expect(bar.getByTestId("sidebar-provider-usage-openai-codex")).toContainText("100%");

  await writeUsageCache(usageCachePath, []);
  await page.reload();
  await expect(bar).not.toBeVisible();
  await expect(footer).toBeVisible();
});

test("refreshes over the connected daemon even when the browser reports offline", async ({
  page,
  usageCachePath,
}) => {
  await writeUsageCache(usageCachePath, [{ provider: "openai-codex", usedFraction: 0.5 }]);
  await gotoAppShell(page);
  const slot = page.getByTestId("sidebar-provider-usage-openai-codex");
  await expect(slot).toContainText("50%");

  // Internet connectivity events do not imply that a local/Tailnet WebSocket is unreachable.
  await page.evaluate(() => window.dispatchEvent(new Event("offline")));
  try {
    await writeUsageCache(usageCachePath, [{ provider: "openai-codex", usedFraction: 0.74 }]);
    await slot.click();
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(slot).toContainText("26%");
  } finally {
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
  }
});

test("shows a usage error instead of silently removing the bar", async ({
  page,
  usageCachePath,
}) => {
  await writeFile(usageCachePath, "{invalid cache");
  await gotoAppShell(page);
  const bar = page.getByTestId("sidebar-provider-usage");
  await expect(bar).toBeVisible();
  await expect(page.getByTestId("sidebar-provider-usage-status")).toContainText(
    "Malformed OMP usage cache",
    { timeout: 15_000 },
  );
  await expect(page.getByTestId("sidebar-footer")).toBeVisible();
});

test("uses the registered host instead of a workspace remembered from a removed host", async ({
  page,
  usageCachePath,
}) => {
  await writeUsageCache(usageCachePath, [{ provider: "openai-codex", usedFraction: 0.74 }]);
  await page.addInitScript(() => {
    localStorage.setItem(
      "paseo:last-workspace-route-selection",
      JSON.stringify({ serverId: "removed-host", workspaceId: "old-workspace" }),
    );
  });
  await gotoAppShell(page);
  await expect(page.getByTestId("sidebar-provider-usage-openai-codex")).toContainText("26%");
  await expect(page.getByTestId("sidebar-provider-usage-status")).toHaveCount(0);
});

test("keeps stale cached percentages and labels them as remaining", async ({
  page,
  usageCachePath,
}) => {
  await writeUsageCache(
    usageCachePath,
    [{ provider: "opencode-go", usedFraction: 0.74 }],
    Date.now() - 10 * 60_000,
  );
  await gotoAppShell(page);
  const slot = page.getByTestId("sidebar-provider-usage-opencode-go");
  await expect(slot).toContainText("26%");
  await slot.click();
  const card = page.getByTestId("provider-usage-card");
  await expect(card.getByText("26% remaining", { exact: true })).toBeVisible();
  await expect(card.getByText(/OMP \(cached\)/)).toBeVisible();
  await expect(card.getByText("Error", { exact: true })).toHaveCount(0);

  await writeUsageCache(usageCachePath, [{ provider: "opencode-go", usedFraction: 0.8 }]);
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(card.getByText("20% remaining", { exact: true })).toBeVisible();
  await expect(card.getByText(/OMP \(cached\)/)).toHaveCount(0);
});
