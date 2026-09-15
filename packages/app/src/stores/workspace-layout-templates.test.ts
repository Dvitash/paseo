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
  instantiateLayoutTemplate,
  isUnshapedWorkspaceLayout,
  useWorkspaceLayoutTemplateStore,
} from "@/stores/workspace-layout-templates";
import {
  createWorkspaceLayoutWithExplorerSidebar,
  useWorkspaceLayoutStore,
  type SplitNode,
  type WorkspaceLayout,
} from "@/stores/workspace-layout-store";
import type { SplitNodeInternal, SplitPaneInternal } from "@/stores/workspace-layout-actions";
import type { WorkspaceTab } from "@/workspace-tabs/model";

const PROJECT_ROOT = "/repo/project";
const WORKSPACE_KEY = "server-1:ws-main";

function createTab(tabId: string, target: WorkspaceTab["target"]): WorkspaceTab {
  return { tabId, target, createdAt: 1 };
}

function paneNode(id: string, tabs: WorkspaceTab[], hidden = false): SplitNodeInternal {
  return {
    kind: "pane",
    pane: {
      id,
      tabIds: tabs.map((tab) => tab.tabId),
      focusedTabId: tabs[tabs.length - 1]?.tabId ?? null,
      tabs,
      ...(hidden ? { hidden: true } : {}),
    },
  };
}

function groupNode(
  id: string,
  direction: "horizontal" | "vertical",
  children: SplitNodeInternal[],
  sizes: number[],
): SplitNodeInternal {
  return { kind: "group", group: { id, direction, children, sizes } };
}

function draftTab(draftId: string): WorkspaceTab {
  return createTab(draftId, { kind: "draft", draftId });
}

function desktopPluginTab(): WorkspaceTab {
  return createTab("plugin_workspace_desktop", {
    kind: "plugin",
    pluginId: "spark-worktree-desktop",
    panelId: "desktop",
    context: "workspace",
  });
}

/** The captured arrangement: chat left, desktop top-right, terminal below. */
function capturedWorktreeLayout(): WorkspaceLayout {
  const explorer = createWorkspaceLayoutWithExplorerSidebar();
  return {
    ...explorer,
    root: groupNode(
      "workspace-root",
      "horizontal",
      [
        groupNode(
          "group-main",
          "horizontal",
          [
            paneNode("pane-chat", [
              draftTab("draft_source"),
              createTab("tab_agent", { kind: "agent", agentId: "agent-1" }),
            ]),
            groupNode(
              "group-right",
              "vertical",
              [
                paneNode("pane-desktop", [desktopPluginTab()]),
                paneNode("pane-terminal", [
                  createTab("terminal_t1", { kind: "terminal", terminalId: "t1" }),
                ]),
              ],
              [0.75, 0.25],
            ),
          ],
          [0.55, 0.45],
        ),
        paneNode("explorer", explorerExplorerTabs(), true),
      ],
      [0.78, 0.22],
    ),
  };
}

function explorerExplorerTabs(): WorkspaceTab[] {
  return [
    createTab("files", { kind: "files" }),
    createTab("changes_tree", { kind: "changes_tree" }),
    createTab("side", { kind: "side" }),
  ];
}

function templateFor(layout: WorkspaceLayout) {
  return buildLayoutTemplate({
    layout,
    splitSizesByGroup: { "group-main": [0.55, 0.45], "group-right": [0.75, 0.25] },
    explorerSidebarPaneId: "explorer",
    sidePaneId: null,
    explorerSidebarWidth: undefined,
    now: 100,
  });
}

function collectTemplatePanes(root: SplitNode): SplitPaneInternal[] {
  const panes: SplitPaneInternal[] = [];
  function walk(node: SplitNode): void {
    if (node.kind === "pane") {
      panes.push(node.pane as SplitPaneInternal);
      return;
    }
    for (const child of node.group.children) {
      walk(child);
    }
  }
  walk(root);
  return panes;
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
});

describe("buildLayoutTemplate", () => {
  it("keeps structure and group sizes", () => {
    const template = templateFor(capturedWorktreeLayout());

    expect(template.version).toBe(1);
    expect(template.savedAt).toBe(100);
    expect(template.splitSizesByGroup).toEqual({
      "group-main": [0.55, 0.45],
      "group-right": [0.75, 0.25],
    });

    const root = template.layout.root;
    expect(root.kind).toBe("group");
    if (root.kind !== "group") return;
    const [main] = root.group.children;
    expect(main?.kind).toBe("group");
    if (!main || main.kind !== "group") return;
    expect(main.group.sizes).toEqual([0.55, 0.45]);
  });

  it("rebuilds tabs into fresh drafts and placeholders while dropping agent tabs", () => {
    const template = templateFor(capturedWorktreeLayout());
    const panes = collectTemplatePanes(template.layout.root);

    const chat = panes.find((p) => p.id === "pane-chat");
    expect(chat?.tabs).toHaveLength(1);
    expect(chat?.tabs[0]?.target).toMatchObject({ kind: "draft" });
    const chatDraft = chat?.tabs[0];
    expect(chatDraft?.target.kind === "draft" && chatDraft.target.draftId).not.toBe("draft_source");

    const desktop = panes.find((p) => p.id === "pane-desktop");
    expect(desktop?.tabs[0]?.target).toMatchObject({
      kind: "plugin",
      pluginId: "spark-worktree-desktop",
      panelId: "desktop",
      context: "workspace",
    });

    const terminal = panes.find((p) => p.id === "pane-terminal");
    expect(terminal?.tabs[0]?.target).toMatchObject({ kind: "new_tab" });
  });

  it("remaps focus to the rebuilt draft when the focused tab was a draft", () => {
    const layout = capturedWorktreeLayout();
    const root = layout.root;
    if (root.kind !== "group") return;
    const main = root.group.children[0];
    if (!main || main.kind !== "group") return;
    const chat = main.group.children[0];
    if (!chat || chat.kind !== "pane") return;
    (chat.pane as SplitPaneInternal).focusedTabId = "draft_source";

    const template = templateFor(layout);
    const rebuiltChat = collectTemplatePanes(template.layout.root).find(
      (p) => p.id === "pane-chat",
    );
    const rebuiltDraft = rebuiltChat?.tabs[0];
    expect(rebuiltDraft?.target.kind).toBe("draft");
    expect(rebuiltChat?.focusedTabId).toBe(
      rebuiltDraft?.target.kind === "draft" ? rebuiltDraft.target.draftId : null,
    );
  });

  it("keeps the explorer sidebar pane hidden with its default tabs", () => {
    const template = templateFor(capturedWorktreeLayout());
    const explorer = collectTemplatePanes(template.layout.root).find(
      (pane) => pane.id === "explorer",
    );
    expect(explorer).toMatchObject({ hidden: true });
    expect(explorer?.tabs.map((tab) => tab.target.kind)).toEqual(["files", "changes_tree", "side"]);
  });

  it("fills a pane that only held dropped tabs with a new-tab placeholder", () => {
    const layout = capturedWorktreeLayout();
    const root = layout.root;
    if (root.kind !== "group") return;
    const main = root.group.children[0];
    if (!main || main.kind !== "group") return;
    const right = main.group.children[1];
    if (!right || right.kind !== "group") return;
    right.group.children[1] = paneNode("pane-terminal", [
      createTab("tab_browser", { kind: "browser", browserId: "b1" }),
    ]);

    const template = templateFor(layout);
    const terminal = collectTemplatePanes(template.layout.root).find(
      (pane) => pane.id === "pane-terminal",
    );
    expect(terminal?.tabs[0]?.target).toMatchObject({ kind: "new_tab" });
  });
});

describe("instantiateLayoutTemplate", () => {
  it("clones the tree and regenerates draft identities per instantiation", () => {
    const template = templateFor(capturedWorktreeLayout());
    const first = instantiateLayoutTemplate(template, 200);
    const second = instantiateLayoutTemplate(template, 300);

    const firstTabs = collectTemplatePanes(first.layout.root).flatMap((pane) => pane.tabs);
    const secondTabs = collectTemplatePanes(second.layout.root).flatMap((pane) => pane.tabs);
    const firstDraft = firstTabs.find((tab) => tab.target.kind === "draft");
    const secondDraft = secondTabs.find((tab) => tab.target.kind === "draft");

    expect(firstDraft?.target.kind).toBe("draft");
    expect(secondDraft?.target.kind).toBe("draft");
    const firstDraftId = firstDraft?.target.kind === "draft" ? firstDraft.target.draftId : "";
    const secondDraftId = secondDraft?.target.kind === "draft" ? secondDraft.target.draftId : "";
    expect(firstDraftId).not.toBe(secondDraftId);
    expect(firstDraft?.tabId).toBe(firstDraftId);
    expect(firstDraft?.createdAt).toBe(200);
    expect(secondDraft?.createdAt).toBe(300);

    // Deterministic targets keep their ids across instantiations.
    const firstDesktop = firstTabs.find((tab) => tab.target.kind === "plugin");
    expect(firstDesktop?.tabId).toBe("plugin_workspace_desktop");
    expect(first.splitSizesByGroup).toEqual(template.splitSizesByGroup);
  });
});

describe("isUnshapedWorkspaceLayout", () => {
  it("treats absent and default layouts as unshaped", () => {
    expect(isUnshapedWorkspaceLayout(null)).toBe(true);
    expect(isUnshapedWorkspaceLayout(createWorkspaceLayoutWithExplorerSidebar())).toBe(true);
  });

  it("treats a user split as arranged", () => {
    expect(isUnshapedWorkspaceLayout(capturedWorktreeLayout())).toBe(false);
  });
});

describe("applyTemplateToWorkspace", () => {
  it("seeds layout, split sizes, and pane registrations exactly once", () => {
    const template = templateFor(capturedWorktreeLayout());
    useWorkspaceLayoutTemplateStore.getState().saveTemplate({
      projectRootPath: PROJECT_ROOT,
      template,
    });

    expect(
      useWorkspaceLayoutTemplateStore.getState().applyTemplateToWorkspace({
        workspaceKey: WORKSPACE_KEY,
        projectRootPath: PROJECT_ROOT,
        now: 400,
      }),
    ).toBe(true);

    const layoutStore = useWorkspaceLayoutStore.getState();
    const seeded = layoutStore.layoutByWorkspace[WORKSPACE_KEY];
    expect(seeded).toBeDefined();
    expect(layoutStore.splitSizesByWorkspace[WORKSPACE_KEY]).toEqual(template.splitSizesByGroup);
    expect(layoutStore.explorerSidebarPaneIdByWorkspace[WORKSPACE_KEY]).toBe("explorer");

    const panes = collectTemplatePanes(seeded?.root ?? paneNode("empty", []));
    expect(panes.map((pane) => pane.id)).toEqual([
      "pane-chat",
      "pane-desktop",
      "pane-terminal",
      "explorer",
    ]);

    // The template applies once; a second call is a no-op.
    expect(
      useWorkspaceLayoutTemplateStore.getState().applyTemplateToWorkspace({
        workspaceKey: WORKSPACE_KEY,
        projectRootPath: PROJECT_ROOT,
        now: 500,
      }),
    ).toBe(false);
  });

  it("refuses to replace a workspace the user already arranged", () => {
    useWorkspaceLayoutTemplateStore.setState({
      templateByProjectRoot: { [PROJECT_ROOT]: templateFor(capturedWorktreeLayout()) },
    });
    useWorkspaceLayoutStore.setState({
      layoutByWorkspace: { [WORKSPACE_KEY]: capturedWorktreeLayout() },
    });

    expect(
      useWorkspaceLayoutTemplateStore.getState().applyTemplateToWorkspace({
        workspaceKey: WORKSPACE_KEY,
        projectRootPath: PROJECT_ROOT,
        now: 400,
      }),
    ).toBe(false);
    expect(useWorkspaceLayoutStore.getState().layoutByWorkspace[WORKSPACE_KEY]).toBeDefined();
  });

  it("carries live agent tabs into the template's focused pane", () => {
    useWorkspaceLayoutTemplateStore.setState({
      templateByProjectRoot: { [PROJECT_ROOT]: templateFor(capturedWorktreeLayout()) },
    });
    const opened = createWorkspaceLayoutWithExplorerSidebar();
    const agentTab = createTab("agent_new", { kind: "agent", agentId: "agent_new" });
    const mainPane = opened.root.kind === "group" ? opened.root.group.children[0] : opened.root;
    if (!mainPane || mainPane.kind !== "pane") return;
    const internalPane = mainPane.pane as SplitPaneInternal;
    internalPane.tabs = [...internalPane.tabs, agentTab];
    internalPane.tabIds = [...internalPane.tabIds, agentTab.tabId];
    useWorkspaceLayoutStore.setState({ layoutByWorkspace: { [WORKSPACE_KEY]: opened } });

    expect(
      useWorkspaceLayoutTemplateStore.getState().applyTemplateToWorkspace({
        workspaceKey: WORKSPACE_KEY,
        projectRootPath: PROJECT_ROOT,
        now: 400,
      }),
    ).toBe(true);

    const seeded = useWorkspaceLayoutStore.getState().layoutByWorkspace[WORKSPACE_KEY];
    const carried = collectTemplatePanes(seeded?.root ?? paneNode("empty", []))
      .flatMap((pane) => pane.tabs)
      .filter((tab) => tab.tabId === "agent_new");
    expect(carried).toHaveLength(1);
  });

  it("does nothing without a template for the project", () => {
    expect(
      useWorkspaceLayoutTemplateStore.getState().applyTemplateToWorkspace({
        workspaceKey: WORKSPACE_KEY,
        projectRootPath: PROJECT_ROOT,
        now: 400,
      }),
    ).toBe(false);
    expect(useWorkspaceLayoutStore.getState().layoutByWorkspace[WORKSPACE_KEY]).toBeUndefined();
  });
});
