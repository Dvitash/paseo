import { expect, test } from "../support/fixtures";
import {
  dropFileOnComposer,
  expectComposerEditable,
  expectComposerVisible,
} from "../support/helpers/composer";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";
import { expectAgentIdle } from "../support/helpers/agent-stream";

const IMAGE = {
  name: "pasted-inline.png",
  mimeType: "image/png",
  buffer: Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    "base64",
  ),
};

test("pasting an image anchors an inline token and hides the top tray", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 960 });
  const agent = await seedMockAgentWorkspace({
    repoPrefix: `inline-image-paste-${testInfo.workerIndex}-`,
    title: "Inline image paste",
    model: "e2e-fast-stream",
  });
  try {
    await openAgentRoute(page, { workspaceId: agent.workspaceId, agentId: agent.agentId });
    await expectComposerVisible(page);
    await expectAgentIdle(page);
    await expectComposerEditable(page);

    const composer = page.getByRole("textbox", { name: "Message agent..." }).first();
    await composer.fill("before ");
    await composer.focus();

    // Build a real DataTransfer in the page and dispatch a cancelable paste at
    // the caret — the same path a browser paste takes.
    await composer.evaluate(
      (el, { name, mimeType, base64 }) => {
        const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
        const file = new File([bytes], name, { type: mimeType });
        const transfer = new DataTransfer();
        transfer.items.add(file);
        const event = new ClipboardEvent("paste", {
          clipboardData: transfer,
          bubbles: true,
          cancelable: true,
        });
        el.dispatchEvent(event);
      },
      {
        name: IMAGE.name,
        mimeType: IMAGE.mimeType,
        base64: IMAGE.buffer.toString("base64"),
      },
    );

    // Exactly one inline marker renders; the top tray stays empty.
    const inlineMarker = page.locator("[data-inline-image]");
    await expect(inlineMarker).toHaveCount(1, { timeout: 10_000 });
    await expect(page.getByTestId("composer-attachment-tray")).toHaveCount(0);

    // The draft text carries a resolvable token, not the raw filename.
    const draft = await composer.inputValue();
    expect(draft).toMatch(/before \[image:[a-z0-9._#-]+\]/);
  } finally {
    await agent.cleanup();
  }
});

test("dropping an image anchors an inline token and hides the top tray", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 960 });
  const agent = await seedMockAgentWorkspace({
    repoPrefix: `inline-image-drop-${testInfo.workerIndex}-`,
    title: "Inline image drop",
    model: "e2e-fast-stream",
  });
  try {
    await openAgentRoute(page, { workspaceId: agent.workspaceId, agentId: agent.agentId });
    await expectComposerVisible(page);
    await expectAgentIdle(page);
    await expectComposerEditable(page);

    const composer = page.getByRole("textbox", { name: "Message agent..." }).first();
    await composer.fill("before ");
    await composer.focus();

    await dropFileOnComposer(page, IMAGE);

    const inlineMarker = page.locator("[data-inline-image]");
    await expect(inlineMarker).toHaveCount(1, { timeout: 10_000 });
    await expect(page.getByTestId("composer-attachment-tray")).toHaveCount(0);

    const draft = await composer.inputValue();
    expect(draft).toMatch(/before \[image:[a-z0-9._#-]+\]/);
  } finally {
    await agent.cleanup();
  }
});
