import { describe, expect, test } from "vitest";
import type { ProviderPaseoToolsPolicy } from "@getpaseo/protocol/provider-config";

import { isPaseoToolEnabled, resolvePaseoToolPolicy } from "./paseo-tool-policy.js";

describe("Paseo tool policy", () => {
  test("defaults to all Paseo tools and resolves only the exact provider ID", () => {
    const customPolicy = {
      enabled: true,
      disabledTools: ["list_agents"],
    } satisfies ProviderPaseoToolsPolicy;

    expect(
      resolvePaseoToolPolicy("custom-claude", {
        claude: { paseoTools: { enabled: false } },
        "custom-claude": { paseoTools: customPolicy },
      }),
    ).toBe(customPolicy);
    expect(resolvePaseoToolPolicy("other-custom", { claude: { paseoTools: customPolicy } })).toBe(
      undefined,
    );
    expect(isPaseoToolEnabled(undefined, "list_agents")).toBe(true);
  });

  test("applies the provider gate and sparse disabled tools without filtering speak", () => {
    expect(isPaseoToolEnabled({ enabled: false }, "list_agents")).toBe(false);
    expect(isPaseoToolEnabled({ enabled: false }, "speak")).toBe(true);
    expect(
      isPaseoToolEnabled({ enabled: true, disabledTools: ["list_agents"] }, "list_agents"),
    ).toBe(false);
    expect(
      isPaseoToolEnabled({ enabled: true, disabledTools: ["list_agents"] }, "create_agent"),
    ).toBe(true);
  });

  test("enabledTools allowlist wins over disabledTools and still keeps speak", () => {
    const policy: ProviderPaseoToolsPolicy = {
      enabled: true,
      enabledTools: ["list_agents", "get_agent_status"],
      disabledTools: ["list_agents"],
    };
    expect(isPaseoToolEnabled(policy, "list_agents")).toBe(true);
    expect(isPaseoToolEnabled(policy, "get_agent_status")).toBe(true);
    expect(isPaseoToolEnabled(policy, "send_agent_prompt")).toBe(false);
    expect(isPaseoToolEnabled(policy, "speak")).toBe(true);
    expect(
      isPaseoToolEnabled({ enabled: false, enabledTools: ["list_agents"] }, "list_agents"),
    ).toBe(false);
  });
});
