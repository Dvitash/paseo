import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@react-native-async-storage/async-storage", () => {
  const storage = new Map<string, string>();
  return {
    default: {
      getItem: vi.fn(async (key: string) => storage.get(key) ?? null),
      setItem: vi.fn(async (key: string, value: string) => {
        storage.set(key, value);
      }),
      removeItem: vi.fn(async (key: string) => {
        storage.delete(key);
      }),
    },
  };
});

import {
  buildLayoutTemplate,
  useWorkspaceLayoutTemplateStore,
  type WorkspaceLayoutTemplate,
} from "@/stores/workspace-layout-templates";
import {
  findPaneById,
  useWorkspaceLayoutStore,
  type WorkspaceLayout,
} from "@/stores/workspace-layout-store";
import type { SplitNodeInternal, SplitPaneInternal } from "@/stores/workspace-layout-actions";
import {
  useWorkspaceDraftSubmissionStore,
  type PendingWorkspaceDraftSubmission,
} from "@/stores/workspace-draft-submission-store";
import type { WorkspaceDraftTabSetup, WorkspaceTab } from "@/workspace-tabs/model";

const WORKSPACE_KEY = "server-1:workspace-1";
const PROJECT_ROOT = "/repo/project";
const SUBMISSION_KEY = {
  serverId: "server-1",
  workspaceId: "workspace-1",
  draftId: "draft_initial_prompt",
};
const SETUP: WorkspaceDraftTabSetup = {
  provider: "codex",
  cwd: "/repo/worktrees/task",
  modeId: "full-access",
  model: "test-model",
  thinkingOptionId: "low",
  featureValues: { testFeature: true },
};

function tab(tabId: string, target: WorkspaceTab["target"]): WorkspaceTab {
  return { tabId, target, createdAt: 10 };
}

function pane(id: string, tabs: WorkspaceTab[]): SplitNodeInternal {
  return {
    kind: "pane",
    pane: {
      id,
      tabs,
      tabIds: tabs.map((item) => item.tabId),
      focusedTabId: tabs[0]?.tabId ?? null,
    },
  };
}

function submittedDraft(): WorkspaceTab {
  return tab(SUBMISSION_KEY.draftId, {
    kind: "draft",
    draftId: SUBMISSION_KEY.draftId,
    setup: SETUP,
  });
}

function pluginTab(): WorkspaceTab {
  return tab("desktop", {
    kind: "plugin",
    pluginId: "workspace-desktop",
    panelId: "desktop",
    context: "workspace",
  });
}

function savedTemplate(): WorkspaceLayoutTemplate {
  return buildLayoutTemplate({
    layout: {
      root: {
        kind: "group",
        group: {
          id: "saved-split",
          direction: "horizontal",
          children: [
            pane("saved-agent", [tab("source-agent", { kind: "agent", agentId: "source" })]),
            pane("saved-tools", [pluginTab()]),
          ],
          sizes: [0.6, 0.4],
        },
      },
      focusedPaneId: "saved-tools",
    },
    splitSizesByGroup: { "saved-split": [0.6, 0.4] },
    explorerSidebarPaneId: null,
    sidePaneId: null,
    explorerSidebarWidth: undefined,
    now: 100,
  });
}

function openTabs(tabs: WorkspaceTab[]): WorkspaceLayout {
  const layout: WorkspaceLayout = {
    root: pane("initial-pane", tabs),
    focusedPaneId: "initial-pane",
  };
  useWorkspaceLayoutStore.setState({ layoutByWorkspace: { [WORKSPACE_KEY]: layout } });
  return layout;
}

function apply(template: WorkspaceLayoutTemplate) {
  useWorkspaceLayoutTemplateStore.getState().saveTemplate({ projectRootPath: PROJECT_ROOT, template });
  return useWorkspaceLayoutTemplateStore.getState().applyTemplateToWorkspace({
    workspaceKey: WORKSPACE_KEY,
    projectRootPath: PROJECT_ROOT,
    now: 200,
  });
}

function currentPane(paneId: string): SplitPaneInternal {
  const layout = useWorkspaceLayoutStore.getState().layoutByWorkspace[WORKSPACE_KEY];
  if (!layout) throw new Error("Expected the workspace layout to exist");
  const result = findPaneById(layout.root, paneId);
  if (!result) throw new Error(`Expected pane ${paneId} to exist`);
  return result as SplitPaneInternal;
}

beforeEach(() => {
  useWorkspaceLayoutTemplateStore.setState({
    templateByProjectRoot: {},
    appliedByWorkspaceKey: {},
  });
  useWorkspaceLayoutStore.setState({
    layoutByWorkspace: {},
    splitSizesByWorkspace: {},
    explorerSidebarPaneIdByWorkspace: {},
    sidePaneIdByWorkspace: {},
    explorerSidebarWidthByWorkspace: {},
  });
  useWorkspaceDraftSubmissionStore.setState({ pendingByDraftId: {}, setupByDraftId: {} });
});

describe("saved layout initial-prompt handoff", () => {
  it("keeps the submitted draft in the agent pane with its payload available exactly once", () => {
    const draft = submittedDraft();
    const pending: PendingWorkspaceDraftSubmission = {
      ...SUBMISSION_KEY,
      cwd: SETUP.cwd,
      provider: SETUP.provider,
      modeId: "full-access",
      model: "test-model",
      thinkingOptionId: "low",
      featureValues: SETUP.featureValues,
      text: "Fix the startup delay",
      attachments: [
        { kind: "workspace_file", path: "src/main.ts", selection: { kind: "whole_file" } },
      ],
      clientMessageId: "initial-message",
      timestamp: 10,
    };
    useWorkspaceDraftSubmissionStore.getState().setPending(pending);
    openTabs([draft]);
    const template = savedTemplate();
    const originalTemplate = structuredClone(template);

    expect(apply(template)).toEqual({ terminalPaneId: null });
    const agentPane = currentPane("saved-agent");
    expect(agentPane.tabs).toEqual([draft]);
    expect(agentPane.tabIds).toEqual([draft.tabId]);
    expect(agentPane.focusedTabId).toBe(draft.tabId);
    expect(currentPane("saved-tools").tabs).toEqual([{ ...pluginTab(), createdAt: 200 }]);
    expect(useWorkspaceLayoutStore.getState().layoutByWorkspace[WORKSPACE_KEY]?.focusedPaneId).toBe(
      "saved-agent",
    );
    expect(useWorkspaceLayoutStore.getState().splitSizesByWorkspace[WORKSPACE_KEY]).toEqual(
      template.splitSizesByGroup,
    );
    expect(template).toEqual(originalTemplate);
    expect(useWorkspaceDraftSubmissionStore.getState().pendingByDraftId[draft.tabId]).toEqual(pending);
    expect(useWorkspaceDraftSubmissionStore.getState().consumePending(SUBMISSION_KEY)).toEqual(pending);
    expect(useWorkspaceDraftSubmissionStore.getState().consumePending(SUBMISSION_KEY)).toBeNull();

    const seeded = useWorkspaceLayoutStore.getState().layoutByWorkspace[WORKSPACE_KEY];
    expect(apply(template)).toBeNull();
    expect(useWorkspaceLayoutStore.getState().layoutByWorkspace[WORKSPACE_KEY]).toBe(seeded);
  });

  it("preserves an unsent draft and its setup without requiring a pending submission", () => {
    const draft = submittedDraft();
    openTabs([draft]);
    apply(savedTemplate());
    expect(currentPane("saved-agent").tabs).toEqual([draft]);
    expect(useWorkspaceDraftSubmissionStore.getState().pendingByDraftId).toEqual({});
  });

  it.each([undefined, "removed-agent-pane"])(
    "finds the saved draft pane when the agent role is %s",
    (agentPaneId) => {
      const draft = submittedDraft();
      openTabs([draft]);
      const template = savedTemplate();
      template.agentPaneId = agentPaneId;
      apply(template);
      expect(currentPane("saved-agent").tabs).toEqual([draft]);
      expect(currentPane("saved-tools").tabs.map((item) => item.target.kind)).toEqual(["plugin"]);
    },
  );

  it("uses a visible pane without dropping the prompt when no agent slot was saved", () => {
    const draft = submittedDraft();
    openTabs([draft]);
    const template = buildLayoutTemplate({
      layout: { root: pane("saved-tools", [pluginTab()]), focusedPaneId: "saved-tools" },
      splitSizesByGroup: {},
      explorerSidebarPaneId: null,
      sidePaneId: null,
      explorerSidebarWidth: undefined,
      now: 100,
    });
    apply(template);
    expect(currentPane("saved-tools").tabs).toEqual([
      { ...pluginTab(), createdAt: 200 },
      draft,
    ]);
    expect(currentPane("saved-tools").focusedTabId).toBe(draft.tabId);
  });

  it("replaces template placeholders but keeps other tabs sharing the agent pane", () => {
    const draft = submittedDraft();
    openTabs([draft]);
    const template = savedTemplate();
    const chat = findPaneById(template.layout.root, "saved-agent") as SplitPaneInternal;
    const sharedPanel = tab("inspector", {
      kind: "plugin",
      pluginId: "inspector",
      panelId: "inspect",
      context: "workspace",
    });
    chat.tabs.push(sharedPanel, tab("placeholder", { kind: "new_tab" }));
    chat.tabIds = chat.tabs.map((item) => item.tabId);
    apply(template);
    expect(currentPane("saved-agent").tabs).toEqual([
      { ...sharedPanel, createdAt: 200 },
      draft,
    ]);
    expect(currentPane("saved-agent").focusedTabId).toBe(draft.tabId);
  });

  it("preserves multiple draft identities without copying them to every saved agent pane", () => {
    const first = submittedDraft();
    const second = tab("draft_second", { kind: "draft", draftId: "draft_second" });
    openTabs([first, second]);
    const template = savedTemplate();
    const tools = findPaneById(template.layout.root, "saved-tools") as SplitPaneInternal;
    tools.tabs = [tab("template_second", { kind: "draft", draftId: "template_second" })];
    tools.tabIds = ["template_second"];
    tools.focusedTabId = "template_second";
    apply(template);
    expect(currentPane("saved-agent").tabs).toEqual([first, second]);
    expect(currentPane("saved-tools").tabs).toHaveLength(1);
    expect(currentPane("saved-tools").tabs[0]?.target.kind).toBe("draft");
    expect(currentPane("saved-tools").tabIds).not.toContain(first.tabId);
    expect(currentPane("saved-tools").tabIds).not.toContain(second.tabId);
  });

  it("still carries the real agent when creation finishes before the template applies", () => {
    const agent = tab("created-agent", { kind: "agent", agentId: "created-agent" });
    openTabs([agent]);
    apply(savedTemplate());
    expect(currentPane("saved-agent").tabs).toEqual([agent]);
    expect(currentPane("saved-agent").focusedTabId).toBe(agent.tabId);
  });

  it("leaves the draft alone when the project has no template", () => {
    const layout = openTabs([submittedDraft()]);
    expect(
      useWorkspaceLayoutTemplateStore.getState().applyTemplateToWorkspace({
        workspaceKey: WORKSPACE_KEY,
        projectRootPath: PROJECT_ROOT,
        now: 200,
      }),
    ).toBeNull();
    expect(useWorkspaceLayoutStore.getState().layoutByWorkspace[WORKSPACE_KEY]).toBe(layout);
  });
});
