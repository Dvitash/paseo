import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { z } from "zod";
import { expect, test as base } from "../support/fixtures";
import { gotoAppShell, openSettings } from "../support/helpers/app";
import { daemonWsRoutePattern, getE2EDaemonPort } from "../support/helpers/daemon-port";
import { startIsolatedHostDaemon } from "../support/helpers/isolated-host-daemon";
import {
  clickSettingsBackToWorkspace,
  openSettingsSection,
  seedSavedSettingsHosts,
} from "../support/helpers/settings";

const test = base.extend<{}, { performanceUsageCache: string }>({
  performanceUsageCache: [
    // Playwright discovers fixture dependencies from the destructuring pattern.
    // eslint-disable-next-line no-empty-pattern
    async ({}, provide) => {
      const directory = await mkdtemp(join(tmpdir(), "paseo-performance-browser-"));
      const cachePath = join(directory, "usage.json");
      const now = Date.now();
      await writeFile(
        cachePath,
        JSON.stringify({
          generatedAt: now,
          reports: [
            {
              provider: "openai-codex",
              fetchedAt: now,
              limits: [
                {
                  id: "weekly",
                  window: { id: "weekly", label: "Weekly", durationMs: 604800000 },
                  amount: { usedFraction: 0.5, remainingFraction: 0.5 },
                  status: "ok",
                },
              ],
            },
          ],
        }),
      );
      try {
        await provide(cachePath);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
    { scope: "worker" },
  ],
  e2eDaemonEnvironment: [
    async ({ performanceUsageCache }, provide) => {
      await provide({ PASEO_OMP_USAGE_CACHE_PATH: performanceUsageCache });
    },
    { scope: "worker" },
  ],
});

test.use({ colorScheme: "dark" });

type GateMode = "pass" | "reject" | "drop";
interface PerformanceGate {
  requests: () => number;
  setMode: (mode: GateMode) => void;
}

const PerformanceEnvelopeSchema = z.object({
  message: z.object({
    type: z.literal("host.performance.get_snapshot.request"),
    requestId: z.string(),
  }),
});

// Only inject transport failures/version drift; successful metric responses come from the real host.
async function installPerformanceGate(page: Page, legacy = false): Promise<PerformanceGate> {
  let requests = 0;
  let mode: GateMode = "pass";
  await page.routeWebSocket(daemonWsRoutePattern(), (browserSocket) => {
    const serverSocket = browserSocket.connectToServer();
    browserSocket.onMessage((message) => {
      const isPerformanceRequest =
        typeof message === "string" && message.includes('"host.performance.get_snapshot.request"');
      if (isPerformanceRequest) {
        const { message: request } = PerformanceEnvelopeSchema.parse(JSON.parse(message));
        requests += 1;
        if (mode === "drop") return;
        if (mode === "reject") {
          browserSocket.send(
            JSON.stringify({
              type: "session",
              message: {
                type: "rpc_error",
                payload: {
                  requestId: request.requestId,
                  requestType: request.type,
                  error: "Performance telemetry temporarily unavailable",
                  code: "handler_error",
                },
              },
            }),
          );
          return;
        }
      }
      serverSocket.send(message);
    });
    serverSocket.onMessage((message) => {
      if (legacy && typeof message === "string") {
        browserSocket.send(
          message.replace(/"hostPerformance"\s*:\s*true/g, '"hostPerformance":false'),
        );
        return;
      }
      browserSocket.send(message);
    });
  });
  return {
    requests: () => requests,
    setMode: (nextMode) => {
      mode = nextMode;
    },
  };
}

test("shows live host metrics above provider usage and opens recent trends", async ({
  page,
}, testInfo) => {
  await gotoAppShell(page);
  const bar = page.getByTestId("sidebar-host-performance");
  const usage = page.getByTestId("sidebar-provider-usage");
  const footer = page.getByTestId("sidebar-footer");
  await expect(bar.getByTestId("sidebar-host-performance-cpu")).toContainText(/CPU\s*\d+%/, {
    timeout: 15_000,
  });
  await expect(bar.getByTestId("sidebar-host-performance-ram")).toContainText(/RAM\s*\d+%/);
  await expect(usage).toContainText("50%");
  const barBounds = await bar.boundingBox();
  const usageBounds = await usage.boundingBox();
  const footerBounds = await footer.boundingBox();
  if (!barBounds || !usageBounds || !footerBounds) throw new Error("Sidebar geometry unavailable");
  expect(barBounds.y + barBounds.height).toBeCloseTo(usageBounds.y, 0);
  expect(usageBounds.y + usageBounds.height).toBeCloseTo(footerBounds.y, 0);
  expect(barBounds.height).toBe(footerBounds.height);
  await page.screenshot({ path: testInfo.outputPath("host-performance-sidebar.png") });
  await bar.getByTestId("sidebar-host-performance-button").click();
  const detail = page.getByTestId("host-performance-detail-sheet");
  await expect(detail).toBeVisible();
  await expect(detail).toContainText("localhost");
  await expect(page.getByTestId("host-performance-cpu-trend")).toBeVisible();
  await expect(page.getByTestId("host-performance-memory-trend")).toBeVisible();
  await expect(detail).toContainText(/\d+(\.\d+)? GB/);
  await expect(
    page.getByTestId("host-performance-cpu-trend").locator("svg path, svg circle"),
  ).not.toHaveCount(0);
  await expect(page.getByTestId("host-performance-cpu-trend").locator("svg > line")).toHaveCount(2);
  await expect(
    page.getByTestId("host-performance-cpu-trend").locator("svg > line").first(),
  ).toHaveAttribute("stroke", /.+/);
  await detail.screenshot({ path: testInfo.outputPath("host-performance-detail.png") });
  await page.keyboard.press("Escape");
  await expect(detail).not.toBeVisible();
});

test("recovers from a failed metrics request using the visible retry action", async ({ page }) => {
  const gate = await installPerformanceGate(page);
  gate.setMode("reject");
  await gotoAppShell(page);
  const bar = page.getByTestId("sidebar-host-performance");
  await expect(bar).toContainText("Performance telemetry temporarily unavailable");
  await bar.getByTestId("sidebar-host-performance-button").click();
  const detail = page.getByTestId("host-performance-detail-sheet");
  await expect(detail).toContainText("Performance telemetry temporarily unavailable");
  const retry = page.getByTestId("host-performance-retry-button");
  await expect(retry).toBeVisible();
  gate.setMode("pass");
  await retry.click();
  await expect(page.getByTestId("host-performance-memory-trend")).toBeVisible();
  await expect(detail).not.toContainText("Performance telemetry temporarily unavailable");
});

test("marks stalled readings instead of presenting them as live", async ({ page }) => {
  const gate = await installPerformanceGate(page);
  await gotoAppShell(page);
  const bar = page.getByTestId("sidebar-host-performance");
  await expect(bar.getByTestId("sidebar-host-performance-cpu")).toContainText(/\d+%/, {
    timeout: 15_000,
  });
  gate.setMode("drop");
  await expect(bar).toContainText(/Stale|timed out|Timeout|Unable to load/i, { timeout: 20_000 });
  await bar.getByTestId("sidebar-host-performance-button").click();
  await expect(page.getByTestId("host-performance-detail-sheet")).toContainText(
    /Stale|timed out|Timeout|Unable to load/i,
  );
});

test("does not request metrics from a host without the capability", async ({ page }) => {
  const gate = await installPerformanceGate(page, true);
  await gotoAppShell(page);
  const bar = page.getByTestId("sidebar-host-performance");
  await expect(bar).toContainText("Update the host");
  await bar.getByTestId("sidebar-host-performance-button").click();
  await expect(page.getByTestId("host-performance-detail-sheet")).toContainText("Update the host");
  // Observe beyond a polling interval: a capability gate must block initial and periodic requests.
  await page.waitForTimeout(3000);
  expect(gate.requests()).toBe(0);
});

test("Appearance toggle persists and stops network demand while hidden", async ({ page }) => {
  const gate = await installPerformanceGate(page);
  await gotoAppShell(page);
  await expect(page.getByTestId("sidebar-host-performance-ram")).toContainText(/\d+%/);
  await openSettings(page);
  await openSettingsSection(page, "appearance");
  const toggle = page.getByRole("switch", { name: "Host performance", exact: true });
  await toggle.click();
  await expect(toggle).not.toBeChecked();
  await clickSettingsBackToWorkspace(page);
  await expect(page.getByTestId("sidebar-host-performance")).toHaveCount(0);
  const countWhenHidden = gate.requests();
  await page.waitForTimeout(3000);
  expect(gate.requests()).toBe(countWhenHidden);
  await openSettings(page);
  await openSettingsSection(page, "appearance");
  await toggle.click();
  await expect(toggle).toBeChecked();
  await clickSettingsBackToWorkspace(page);
  await expect(page.getByTestId("sidebar-host-performance-ram")).toContainText(/\d+%/);
  await expect.poll(gate.requests).toBeGreaterThan(countWhenHidden);
});

test("compact sidebar fits metrics and suspends polling when closed", async ({
  page,
}, testInfo) => {
  const gate = await installPerformanceGate(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await gotoAppShell(page);
  await page.getByRole("button", { name: "Open menu", exact: true }).click();
  const bar = page.getByTestId("sidebar-host-performance");
  await expect(bar.getByTestId("sidebar-host-performance-ram")).toContainText(/\d+%/);
  const bounds = await bar.boundingBox();
  if (!bounds) throw new Error("Compact performance geometry unavailable");
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(390);
  await page.screenshot({ path: testInfo.outputPath("host-performance-compact.png") });
  await page.getByTestId("sidebar-close").click();
  const countWhenHidden = gate.requests();
  await page.waitForTimeout(3000);
  expect(gate.requests()).toBe(countWhenHidden);
});

test("selects a named host without navigation and marks that host disconnected", async ({
  page,
}, testInfo) => {
  const remote = await startIsolatedHostDaemon("performance-secondary-host");
  try {
    const localServerId = process.env.E2E_SERVER_ID;
    if (!localServerId) throw new Error("Worker host identity unavailable");
    await seedSavedSettingsHosts(page, [
      { serverId: localServerId, label: "Local host", endpoint: `127.0.0.1:${getE2EDaemonPort()}` },
      {
        serverId: remote.serverId,
        label: "Remote performance host",
        endpoint: `127.0.0.1:${remote.port}`,
      },
    ]);
    await page.reload();
    const bar = page.getByTestId("sidebar-host-performance");
    const picker = page.getByTestId("sidebar-host-performance-picker");
    await expect(picker).toBeVisible();
    await expect(bar.getByTestId("sidebar-host-performance-ram")).toContainText(/\d+%/);
    const originalUrl = page.url();
    await picker.click();
    await page.getByText("Remote performance host", { exact: true }).click();
    await expect(picker).toContainText("Remote performance host");
    await expect(bar.getByTestId("sidebar-host-performance-ram")).toContainText(/\d+%/);
    expect(page.url()).toBe(originalUrl);
    const barBounds = await bar.boundingBox();
    const ramBounds = await bar.getByTestId("sidebar-host-performance-ram").boundingBox();
    if (!barBounds || !ramBounds) throw new Error("Multi-host metric geometry unavailable");
    expect(ramBounds.x + ramBounds.width).toBeLessThanOrEqual(barBounds.x + barBounds.width);
    const pickerBounds = await picker.boundingBox();
    const cpuBounds = await bar.getByTestId("sidebar-host-performance-cpu").boundingBox();
    if (!pickerBounds || !cpuBounds) throw new Error("Host picker geometry unavailable");
    expect(pickerBounds.x).toBeGreaterThanOrEqual(barBounds.x);
    expect(pickerBounds.x + pickerBounds.width).toBeLessThanOrEqual(cpuBounds.x);
    const label = picker.getByText("Remote performance host", { exact: true });
    await expect(label).toHaveCSS("white-space", "nowrap");
    const labelBounds = await label.boundingBox();
    if (!labelBounds) throw new Error("Host label geometry unavailable");
    expect(labelBounds.x).toBeGreaterThanOrEqual(pickerBounds.x);
    expect(labelBounds.x + labelBounds.width).toBeLessThanOrEqual(
      pickerBounds.x + pickerBounds.width,
    );
    await bar.screenshot({ path: testInfo.outputPath("host-performance-multiple-hosts.png") });
    await bar.getByTestId("sidebar-host-performance-button").click();
    await expect(page.getByTestId("host-performance-detail-sheet")).toContainText(
      "Remote performance host",
    );
    await page.keyboard.press("Escape");
    await remote.close();
    await expect(bar).toContainText("Connect to this host to see performance");
    await expect(bar.getByTestId("sidebar-host-performance-cpu")).toHaveCount(0);
    await expect(picker).toContainText("Remote performance host");
  } finally {
    await remote.close();
  }
});
