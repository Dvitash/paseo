import AsyncStorage from "@react-native-async-storage/async-storage";
import { useEffect, useState } from "react";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { z } from "zod";
import {
  collectAllPanes,
  collectAllTabs,
  findPaneById,
  normalizeLayout,
  useWorkspaceLayoutStore,
  useWorkspaceLayoutStoreHydrated,
  WorkspaceLayoutStorageSchema,
  type WorkspaceLayout,
} from "@/stores/workspace-layout-store";
import {
  EXPLORER_SIDEBAR_PANE_ID,
  asInternalNode,
  type SplitNodeInternal,
} from "@/stores/workspace-layout-actions";
import { createValidatedPersistStorage } from "@/storage/validated-persist-storage";
import { generateDraftId } from "@/stores/draft-keys";
import { generateMessageId } from "@/types/stream";
import { createNewWorkspaceTab } from "@/workspace-tabs/new-tab";
import type { WorkspaceTab } from "@/workspace-tabs/model";

/**
 * A reusable pane arrangement captured from one workspace and seeded into new
 * workspaces of the same project. The stored tree keeps the Explorer shell and
 * pane structure; workspace-bound tab targets are rebuilt on instantiation.
 */
const WorkspaceLayoutTemplateStorageSchema = z.strictObject({
  version: z.literal(1),
  layout: WorkspaceLayoutStorageSchema,
  splitSizesByGroup: z.record(z.string(), z.array(z.number())),
  explorerSidebarPaneId: z.string().nullable(),
  sidePaneId: z.string().nullable(),
  explorerSidebarWidth: z.number().nullable(),
  savedAt: z.number(),
});

const WorkspaceLayoutTemplatesPersistedStateSchema = z.strictObject({
  templateByProjectRoot: z.record(z.string(), WorkspaceLayoutTemplateStorageSchema),
  appliedByWorkspaceKey: z.record(z.string(), z.string()),
});

export type WorkspaceLayoutTemplate = z.infer<typeof WorkspaceLayoutTemplateStorageSchema>;

interface BuildLayoutTemplateInput {
  layout: WorkspaceLayout;
  splitSizesByGroup: Record<string, number[]> | undefined;
  explorerSidebarPaneId: string | null;
  sidePaneId: string | null;
  explorerSidebarWidth: number | undefined;
  now: number;
}

/**
 * Rebuilds a tab for the template. Deterministic targets (workspace plugin
 * panels, Explorer views) are kept as-is; a draft becomes a fresh draft so two
 * instantiated workspaces never alias one composer draft; a terminal becomes a
 * new-tab placeholder because terminal sessions cannot be cloned.
 */
function buildTemplateTab(tab: WorkspaceTab, now: number): WorkspaceTab | null {
  const target = tab.target;
  if (target.kind === "plugin") {
    return target.context === "workspace" ? { tabId: tab.tabId, target, createdAt: now } : null;
  }
  if (target.kind === "changes_tree" || target.kind === "files" || target.kind === "side") {
    return { tabId: tab.tabId, target, createdAt: now };
  }
  if (target.kind === "draft") {
    const draftId = generateDraftId();
    return { tabId: draftId, target: { kind: "draft", draftId }, createdAt: now };
  }
  if (target.kind === "terminal") {
    return { tabId: `tab_${generateMessageId()}`, target: { kind: "new_tab" }, createdAt: now };
  }
  return null;
}

function buildTemplateNode(node: SplitNodeInternal, now: number): SplitNodeInternal {
  if (node.kind === "pane") {
    let focusedTabId: string | null = null;
    const rebuiltTabs: WorkspaceTab[] = [];
    for (const tab of node.pane.tabs) {
      const rebuilt = buildTemplateTab(tab, now);
      if (!rebuilt) continue;
      rebuiltTabs.push(rebuilt);
      if (tab.tabId === node.pane.focusedTabId) {
        focusedTabId = rebuilt.tabId;
      }
    }
    const tabs = rebuiltTabs.length > 0 ? rebuiltTabs : [createNewWorkspaceTab()];
    return {
      kind: "pane",
      pane: {
        id: node.pane.id,
        tabIds: tabs.map((tab) => tab.tabId),
        focusedTabId: focusedTabId ?? tabs[0]?.tabId ?? null,
        tabs,
        ...(node.pane.hidden === true ? { hidden: true } : {}),
      },
    };
  }
  return {
    kind: "group",
    group: {
      id: node.group.id,
      direction: node.group.direction,
      children: node.group.children.map((child) => buildTemplateNode(child, now)),
      sizes: [...node.group.sizes],
    },
  };
}

/**
 * Captures the workspace's current arrangement. Tabs bound to workspace-local
 * resources (agents, terminals, files, browsers) are dropped; panes left empty
 * by that fall back to a new-tab placeholder so the structure survives.
 */
export function buildLayoutTemplate(input: BuildLayoutTemplateInput): WorkspaceLayoutTemplate {
  const normalized = normalizeLayout(input.layout);
  const layout = normalizeLayout({
    root: buildTemplateNode(asInternalNode(normalized.root), input.now),
    focusedPaneId: normalized.focusedPaneId,
  });
  return {
    version: 1,
    layout,
    splitSizesByGroup: input.splitSizesByGroup ? { ...input.splitSizesByGroup } : {},
    explorerSidebarPaneId: input.explorerSidebarPaneId,
    sidePaneId: input.sidePaneId,
    explorerSidebarWidth: input.explorerSidebarWidth ?? null,
    savedAt: input.now,
  };
}

/**
 * A workspace that still has its default arrangement: at most one visible pane.
 * User splits and open-beside panes always produce a second visible pane, so
 * pane count alone separates "never arranged" from "arranged".
 */
export function isUnshapedWorkspaceLayout(layout: WorkspaceLayout | null): boolean {
  if (!layout) {
    return true;
  }
  return collectAllPanes(normalizeLayout(layout).root).length <= 1;
}

/** Tabs that reference live workspace resources and survive a template apply. */
function isCarriedTab(tab: WorkspaceTab): boolean {
  const kind = tab.target.kind;
  return (
    kind === "agent" ||
    kind === "provider_subagent" ||
    kind === "setup" ||
    kind === "browser" ||
    kind === "file" ||
    kind === "working_diff" ||
    kind === "commit_diff" ||
    kind === "pull_request" ||
    (kind === "plugin" && tab.target.context === "agent")
  );
}

function instantiateTemplateTab(
  tab: WorkspaceTab,
  now: number,
  tabIdRemap: Map<string, string>,
): WorkspaceTab {
  if (tab.target.kind === "draft") {
    // Draft content is keyed by server + draft id, not per workspace, so a cloned
    // draft id would alias the source workspace's composer draft.
    const draftId = generateDraftId();
    tabIdRemap.set(tab.tabId, draftId);
    return { tabId: draftId, target: { kind: "draft", draftId }, createdAt: now };
  }
  return { tabId: tab.tabId, target: tab.target, createdAt: now };
}

function instantiateTemplateNode(
  node: SplitNodeInternal,
  now: number,
  tabIdRemap: Map<string, string>,
): SplitNodeInternal {
  if (node.kind === "pane") {
    const tabs = node.pane.tabs.map((tab) => instantiateTemplateTab(tab, now, tabIdRemap));
    const focusedTabId =
      node.pane.focusedTabId !== null
        ? (tabIdRemap.get(node.pane.focusedTabId) ?? tabs[0]?.tabId ?? null)
        : null;
    return {
      kind: "pane",
      pane: {
        id: node.pane.id,
        tabIds: tabs.map((tab) => tab.tabId),
        focusedTabId,
        tabs,
        ...(node.pane.hidden === true ? { hidden: true } : {}),
      },
    };
  }
  return {
    kind: "group",
    group: {
      id: node.group.id,
      direction: node.group.direction,
      children: node.group.children.map((child) => instantiateTemplateNode(child, now, tabIdRemap)),
      sizes: [...node.group.sizes],
    },
  };
}

export function instantiateLayoutTemplate(
  template: WorkspaceLayoutTemplate,
  now: number,
): { layout: WorkspaceLayout; splitSizesByGroup: Record<string, number[]> } {
  const tabIdRemap = new Map<string, string>();
  const layout = normalizeLayout({
    root: instantiateTemplateNode(asInternalNode(template.layout.root), now, tabIdRemap),
    focusedPaneId: template.layout.focusedPaneId,
  });
  return { layout, splitSizesByGroup: { ...template.splitSizesByGroup } };
}

function appendTabsToPane(
  node: SplitNodeInternal,
  paneId: string,
  tabs: WorkspaceTab[],
): SplitNodeInternal {
  if (tabs.length === 0) {
    return node;
  }
  if (node.kind === "pane") {
    if (node.pane.id !== paneId) {
      return node;
    }
    return {
      kind: "pane",
      pane: {
        id: node.pane.id,
        tabIds: [...node.pane.tabIds, ...tabs.map((tab) => tab.tabId)],
        focusedTabId: node.pane.focusedTabId,
        tabs: [...node.pane.tabs, ...tabs],
        ...(node.pane.hidden === true ? { hidden: true } : {}),
      },
    };
  }
  return {
    kind: "group",
    group: {
      id: node.group.id,
      direction: node.group.direction,
      children: node.group.children.map((child) => appendTabsToPane(child, paneId, tabs)),
      sizes: [...node.group.sizes],
    },
  };
}

function selectTemplateTargetPaneId(layout: WorkspaceLayout): string {
  const focusedPane = findPaneById(layout.root, layout.focusedPaneId);
  if (focusedPane && focusedPane.hidden !== true) {
    return focusedPane.id;
  }
  return collectAllPanes(layout.root)[0]?.id ?? EXPLORER_SIDEBAR_PANE_ID;
}

interface WorkspaceLayoutTemplateState {
  templateByProjectRoot: Record<string, WorkspaceLayoutTemplate>;
  appliedByWorkspaceKey: Record<string, string>;
  saveTemplate: (input: { projectRootPath: string; template: WorkspaceLayoutTemplate }) => void;
  clearTemplate: (projectRootPath: string) => void;
  /**
   * Seeds the workspace's layout from the project template. Applies only once per
   * workspace and only while the workspace still has its default single-pane
   * arrangement, so a layout the user (or an opener flow) already arranged wins.
   */
  applyTemplateToWorkspace: (input: {
    workspaceKey: string;
    projectRootPath: string;
    now: number;
  }) => boolean;
}

export const useWorkspaceLayoutTemplateStore = create<WorkspaceLayoutTemplateState>()(
  persist(
    (set, get) => ({
      templateByProjectRoot: {},
      appliedByWorkspaceKey: {},
      saveTemplate: ({ projectRootPath, template }) => {
        set((state) => ({
          templateByProjectRoot: {
            ...state.templateByProjectRoot,
            [projectRootPath]: template,
          },
        }));
      },
      clearTemplate: (projectRootPath) => {
        set((state) => {
          const templateByProjectRoot = { ...state.templateByProjectRoot };
          delete templateByProjectRoot[projectRootPath];
          return { templateByProjectRoot };
        });
      },
      applyTemplateToWorkspace: ({ workspaceKey, projectRootPath, now }) => {
        const template = get().templateByProjectRoot[projectRootPath];
        if (!template) {
          return false;
        }
        if (get().appliedByWorkspaceKey[workspaceKey]) {
          return false;
        }
        const layoutStore = useWorkspaceLayoutStore.getState();
        const existingLayout = layoutStore.layoutByWorkspace[workspaceKey] ?? null;
        if (!isUnshapedWorkspaceLayout(existingLayout)) {
          return false;
        }
        const instantiated = instantiateLayoutTemplate(template, now);
        const carriedTabs = existingLayout
          ? collectAllTabs(normalizeLayout(existingLayout).root).filter(isCarriedTab)
          : [];
        const layout = appendTabsToPane(
          asInternalNode(instantiated.layout.root),
          selectTemplateTargetPaneId(instantiated.layout),
          carriedTabs,
        );
        layoutStore.seedWorkspaceLayout(workspaceKey, {
          layout: normalizeLayout({
            root: layout,
            focusedPaneId: instantiated.layout.focusedPaneId,
          }),
          splitSizesByGroup: instantiated.splitSizesByGroup,
          explorerSidebarPaneId: template.explorerSidebarPaneId,
          sidePaneId: template.sidePaneId,
          explorerSidebarWidth: template.explorerSidebarWidth,
        });
        set((state) => ({
          appliedByWorkspaceKey: {
            ...state.appliedByWorkspaceKey,
            [workspaceKey]: projectRootPath,
          },
        }));
        return true;
      },
    }),
    {
      name: "workspace-layout-templates",
      version: 1,
      storage: createValidatedPersistStorage(
        AsyncStorage,
        WorkspaceLayoutTemplatesPersistedStateSchema,
      ),
      partialize: (state) => ({
        templateByProjectRoot: state.templateByProjectRoot,
        appliedByWorkspaceKey: state.appliedByWorkspaceKey,
      }),
    },
  ),
);

export function useWorkspaceLayoutTemplateStoreHydrated(): boolean {
  const [hasHydrated, setHasHydrated] = useState(() =>
    useWorkspaceLayoutTemplateStore.persist.hasHydrated(),
  );

  useEffect(() => {
    if (useWorkspaceLayoutTemplateStore.persist.hasHydrated()) {
      setHasHydrated(true);
      return;
    }
    return useWorkspaceLayoutTemplateStore.persist.onFinishHydration(() => {
      setHasHydrated(true);
    });
  }, []);

  return hasHydrated;
}

interface ApplyWorkspaceLayoutTemplateInput {
  workspaceKey: string | null;
  projectRootPath: string | null;
  enabled: boolean;
}

/** Seeds a newly opened workspace with its project's saved layout template. */
export function useApplyWorkspaceLayoutTemplate(input: ApplyWorkspaceLayoutTemplateInput): void {
  const layoutHydrated = useWorkspaceLayoutStoreHydrated();
  const templatesHydrated = useWorkspaceLayoutTemplateStoreHydrated();
  const applyTemplateToWorkspace = useWorkspaceLayoutTemplateStore(
    (state) => state.applyTemplateToWorkspace,
  );

  useEffect(() => {
    if (
      !input.enabled ||
      input.workspaceKey === null ||
      input.projectRootPath === null ||
      !layoutHydrated ||
      !templatesHydrated
    ) {
      return;
    }
    applyTemplateToWorkspace({
      workspaceKey: input.workspaceKey,
      projectRootPath: input.projectRootPath,
      now: Date.now(),
    });
  }, [
    applyTemplateToWorkspace,
    input.enabled,
    input.projectRootPath,
    input.workspaceKey,
    layoutHydrated,
    templatesHydrated,
  ]);
}
