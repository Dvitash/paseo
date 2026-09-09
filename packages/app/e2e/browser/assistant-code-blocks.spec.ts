import { expect, test } from "../support/fixtures";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";

const MARKDOWN = [
  "Code block regression fixture.",
  "",
  "```",
  "```",
  "",
  "```text",
  "   ",
  "\t",
  "```",
  "",
  "```bash",
  "  echo readable",
  "```",
  "",
  "```",
  "plain code",
  "```",
  "",
  "Trailing empty fence:",
  "",
  "```",
].join("\n");

test("empty assistant fences have no box or copy control; populated code remains readable and copyable", async ({
  context,
  page,
}) => {
  const agent = await seedMockAgentWorkspace({
    repoPrefix: "assistant-code-blocks-",
    title: "Assistant code blocks",
    initialPrompt: "Render the code block fixture.",
    featureValues: { mockAssistantResponse: MARKDOWN },
  });

  try {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await agent.client.waitForAgentUpsert(
      agent.agentId,
      (snapshot) => snapshot.status === "idle",
      30_000,
    );
    await openAgentRoute(page, agent);

    const message = page.getByTestId("assistant-message").filter({
      hasText: "Code block regression fixture.",
    });
    await expect(message).toContainText("Trailing empty fence:");
    const blocks = message.locator('[data-paseo-markdown-tag="pre"]');
    await expect(blocks).toHaveCount(2);
    for (const [index, code] of ["  echo readable", "plain code"].entries()) {
      const block = blocks.nth(index);
      const text = block.locator('[data-paseo-markdown-tag="code"]');
      await expect(text).toBeVisible();
      await expect(text).toHaveText(code);
      await block.hover();
      await block.getByRole("button", { name: "Copy code", exact: true }).click();
      await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(code);
    }
  } finally {
    await agent.cleanup();
  }
});
