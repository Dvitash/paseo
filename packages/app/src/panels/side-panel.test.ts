import { describe, expect, it } from "vitest";
import {
  resolveSelectedMainAgent,
  resolveEffectiveSideProvider,
  SIDE_CHAT_TEST_IDS,
} from "./side-panel-state";
import { getPanelManifest, panelSupportsHost, panelResourceKey } from "@/panels/panel-manifest";
import type { WorkspaceLayout } from "@/stores/workspace-layout-actions";

describe("side-panel pure unit tests", () => {
  describe("resolveSelectedMainAgent", () => {
    it("returns null fields when layout is null", () => {
      const result = resolveSelectedMainAgent({
        layout: null,
        explorerSidebarPaneId: null,
      });
      expect(result).toEqual({
        mainAgentId: null,
        mainAgentTitle: null,
        mainAgentProvider: null,
      });
    });

    it("returns null fields when the active pane has no focusedTabId", () => {
      const layout: WorkspaceLayout = {
        root: {
          kind: "pane",
          pane: {
            id: "main-pane",
            tabIds: [],
            focusedTabId: null,
          },
        },
        focusedPaneId: "main-pane",
      };
      const result = resolveSelectedMainAgent({
        layout,
        explorerSidebarPaneId: null,
      });
      expect(result).toEqual({
        mainAgentId: null,
        mainAgentTitle: null,
        mainAgentProvider: null,
      });
    });

    it("returns null fields when active tab is not an agent tab", () => {
      const layout = {
        root: {
          kind: "pane" as const,
          pane: {
            id: "main-pane",
            tabIds: ["tab-files"],
            focusedTabId: "tab-files",
            tabs: [
              {
                tabId: "tab-files",
                target: { kind: "files" as const },
                createdAt: 100,
              },
            ],
          },
        },
        focusedPaneId: "main-pane",
      };
      const result = resolveSelectedMainAgent({
        layout,
        explorerSidebarPaneId: null,
      });
      expect(result.mainAgentId).toBeNull();
    });

    it("resolves main agent id, title, and provider from focused main pane with agent tab", () => {
      const layout = {
        root: {
          kind: "pane" as const,
          pane: {
            id: "main-pane",
            tabIds: ["tab-agent-1"],
            focusedTabId: "tab-agent-1",
            tabs: [
              {
                tabId: "tab-agent-1",
                target: { kind: "agent" as const, agentId: "agent-alpha" },
                createdAt: 100,
              },
            ],
          },
        },
        focusedPaneId: "main-pane",
      };
      const result = resolveSelectedMainAgent({
        layout,
        explorerSidebarPaneId: "explorer-pane",
        agent: { title: "Implement Auth Flow", provider: "claude" },
      });
      expect(result).toEqual({
        mainAgentId: "agent-alpha",
        mainAgentTitle: "Implement Auth Flow",
        mainAgentProvider: "claude",
      });
    });

    it("resolves parentAgentId when focused tab is a provider_subagent", () => {
      const layout = {
        root: {
          kind: "pane" as const,
          pane: {
            id: "main-pane",
            tabIds: ["tab-subagent-1"],
            focusedTabId: "tab-subagent-1",
            tabs: [
              {
                tabId: "tab-subagent-1",
                target: {
                  kind: "provider_subagent" as const,
                  parentAgentId: "agent-parent",
                  subagentId: "sub-1",
                },
                createdAt: 100,
              },
            ],
          },
        },
        focusedPaneId: "main-pane",
      };
      const result = resolveSelectedMainAgent({
        layout,
        explorerSidebarPaneId: null,
        agent: { title: "Root Agent", provider: "codex" },
      });
      expect(result).toEqual({
        mainAgentId: "agent-parent",
        mainAgentTitle: "Root Agent",
        mainAgentProvider: "codex",
      });
    });

    it("ignores explorerSidebarPaneId when focusedPaneId points to it and uses main pane", () => {
      const layout = {
        root: {
          kind: "group" as const,
          group: {
            id: "root-group",
            direction: "horizontal" as const,
            sizes: [0.8, 0.2],
            children: [
              {
                kind: "pane" as const,
                pane: {
                  id: "main-pane",
                  tabIds: ["tab-agent-1"],
                  focusedTabId: "tab-agent-1",
                  tabs: [
                    {
                      tabId: "tab-agent-1",
                      target: { kind: "agent" as const, agentId: "agent-in-main" },
                      createdAt: 100,
                    },
                  ],
                },
              },
              {
                kind: "pane" as const,
                pane: {
                  id: "explorer-pane",
                  tabIds: ["tab-side"],
                  focusedTabId: "tab-side",
                  tabs: [
                    {
                      tabId: "tab-side",
                      target: { kind: "side" as const },
                      createdAt: 100,
                    },
                  ],
                },
              },
            ],
          },
        },
        focusedPaneId: "explorer-pane",
      };
      const result = resolveSelectedMainAgent({
        layout,
        explorerSidebarPaneId: "explorer-pane",
        agent: { title: "Main Task" },
      });
      expect(result.mainAgentId).toBe("agent-in-main");
      expect(result.mainAgentTitle).toBe("Main Task");
    });
  });

  describe("resolveEffectiveSideProvider", () => {
    it("returns active side provider when already set", () => {
      expect(
        resolveEffectiveSideProvider({
          activeSideProvider: "codex",
          mainAgentProvider: "claude",
          supportedProviders: ["claude", "codex"],
        }),
      ).toBe("codex");
    });

    it("defaults to mainAgentProvider when it is among supportedProviders", () => {
      expect(
        resolveEffectiveSideProvider({
          activeSideProvider: null,
          mainAgentProvider: "claude",
          supportedProviders: ["codex", "claude"],
        }),
      ).toBe("claude");
    });

    it("falls back to first supported provider when main agent provider is unsupported", () => {
      expect(
        resolveEffectiveSideProvider({
          activeSideProvider: null,
          mainAgentProvider: "omp-pi",
          supportedProviders: ["claude", "codex"],
        }),
      ).toBe("claude");
    });

    it("returns null when no providers are supported", () => {
      expect(
        resolveEffectiveSideProvider({
          activeSideProvider: null,
          mainAgentProvider: "omp-pi",
          supportedProviders: [],
        }),
      ).toBeNull();
    });
  });

  describe("side panel manifest", () => {
    it("declares singleton explorer-only registration in manifest", () => {
      const manifest = getPanelManifest("side");
      expect(manifest.kind).toBe("side");
      expect(manifest.supportedHosts).toEqual(["explorer"]);
      expect(manifest.resourceKey({ kind: "side" })).toBe("side");
      expect(panelSupportsHost("side", "explorer")).toBe(true);
      expect(panelSupportsHost("side", "main")).toBe(false);
      expect(panelResourceKey({ kind: "side" })).toBe("side:side");
    });
  });

  describe("SIDE_CHAT_TEST_IDS", () => {
    it("exports stable test IDs for E2E browser and UI tests", () => {
      expect(SIDE_CHAT_TEST_IDS.view).toBe("side-chat-view");
      expect(SIDE_CHAT_TEST_IDS.header).toBe("side-panel-linked-header");
      expect(SIDE_CHAT_TEST_IDS.emptyState).toBe("side-panel-empty-state");
      expect(SIDE_CHAT_TEST_IDS.capabilityMissing).toBe("side-panel-capability-missing");
      expect(SIDE_CHAT_TEST_IDS.input).toBe("side-input");
      expect(SIDE_CHAT_TEST_IDS.sendButton).toBe("side-send-button");
      expect(SIDE_CHAT_TEST_IDS.statusButton).toBe("side-status-button");
      expect(SIDE_CHAT_TEST_IDS.providerTrigger).toBe("side-provider-trigger");
      expect(SIDE_CHAT_TEST_IDS.providerBadge).toBe("side-provider-badge");
      expect(SIDE_CHAT_TEST_IDS.unsupportedBanner).toBe("side-unsupported-provider-banner");
      expect(SIDE_CHAT_TEST_IDS.steeringCard).toBe("side-steering-card");
      expect(SIDE_CHAT_TEST_IDS.steeringInput).toBe("side-steering-input");
      expect(SIDE_CHAT_TEST_IDS.steeringSendButton).toBe("side-steering-send-button");
    });
  });
});
