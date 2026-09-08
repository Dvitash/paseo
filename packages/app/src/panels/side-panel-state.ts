import {
  collectAllPanes,
  collectAllTabs,
  findPaneById,
  type SplitNode,
} from "@/stores/workspace-layout-actions";

export const SIDE_CHAT_TEST_IDS = {
  view: "side-chat-view",
  header: "side-panel-linked-header",
  emptyState: "side-panel-empty-state",
  capabilityMissing: "side-panel-capability-missing",
  loading: "side-chat-loading",
  error: "side-chat-error",
  errorBanner: "side-error-banner",
  input: "side-input",
  sendButton: "side-send-button",
  runningIndicator: "side-running-indicator",
  stopButton: "side-stop-button",
  providerTrigger: "side-provider-trigger",
  providerBadge: "side-provider-badge",
  unsupportedBanner: "side-unsupported-provider-banner",
  steeringCard: "side-steering-card",
  steeringInput: "side-steering-input",
  steeringSendButton: "side-steering-send-button",
} as const;

export interface SelectedMainAgent {
  mainAgentId: string | null;
  mainAgentTitle: string | null;
  mainAgentProvider: string | null;
}

export function resolveEffectiveSideProvider(input: {
  activeSideProvider?: string | null;
  mainAgentProvider?: string | null;
  supportedProviders?: string[];
}): string | null {
  if (input.activeSideProvider) return input.activeSideProvider;
  const supported = input.supportedProviders ?? [];
  if (input.mainAgentProvider && supported.includes(input.mainAgentProvider)) {
    return input.mainAgentProvider;
  }
  return supported[0] ?? null;
}

export function resolveSelectedMainAgent(input: {
  layout: { root: SplitNode; focusedPaneId: string | null } | null;
  explorerSidebarPaneId: string | null;
  agent?: { title?: string | null; provider?: string | null } | null;
}): SelectedMainAgent {
  if (!input.layout) {
    return { mainAgentId: null, mainAgentTitle: null, mainAgentProvider: null };
  }
  const panes = collectAllPanes(input.layout.root);
  let activePane =
    input.layout.focusedPaneId && input.layout.focusedPaneId !== input.explorerSidebarPaneId
      ? findPaneById(input.layout.root, input.layout.focusedPaneId)
      : null;

  if (!activePane) {
    activePane = panes.find((p) => p.id !== input.explorerSidebarPaneId) ?? null;
  }

  if (!activePane || !activePane.focusedTabId) {
    return { mainAgentId: null, mainAgentTitle: null, mainAgentProvider: null };
  }

  const allTabs = collectAllTabs(input.layout.root);
  const activeTab = allTabs.find((t) => t.tabId === activePane.focusedTabId);
  if (!activeTab) return { mainAgentId: null, mainAgentTitle: null, mainAgentProvider: null };

  let mainAgentId: string | null = null;
  if (activeTab.target.kind === "agent") {
    mainAgentId = activeTab.target.agentId;
  } else if (activeTab.target.kind === "provider_subagent") {
    mainAgentId = activeTab.target.parentAgentId;
  }

  if (!mainAgentId) {
    return { mainAgentId: null, mainAgentTitle: null, mainAgentProvider: null };
  }

  return {
    mainAgentId,
    mainAgentTitle: input.agent?.title?.trim() || null,
    mainAgentProvider: input.agent?.provider ?? null,
  };
}
