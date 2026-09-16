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
  type SplitPaneInternal,
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
  agentPaneId: z.string().nullable().optional(),
  terminalPaneId: z.string().nullable().optional(),
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

interface TemplatePaneRoles {
  agentPaneId: string | null;
  terminalPaneId: string | null;
}

/**
 * Rebuilds a tab for the template. Deterministic targets (workspace plugin
 * panels, Explorer views) are kept as-is; a draft becomes a fresh draft so two
 * instantiated workspaces never alias one composer draft. Live agents and
 * terminals are represented by pane roles because their session ids cannot be
 * cloned into a new workspace.
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
    const hasDraft = node.pane.tabs.some((tab) => tab.target.kind === "draft");
    const hasAgent = node.pane.tabs.some((tab) => tab.target.kind === "agent");
    for (const tab of node.pane.tabs) {
      const rebuilt = buildTemplateTab(tab, now);
      if (!rebuilt) continue;
      rebuiltTabs.push(rebuilt);
      if (tab.tabId === node.pane.focusedTabId) {
        focusedTabId = rebuilt.tabId;
      }
    }
    if (hasAgent && !hasDraft) {
      const draftId = generateDraftId();
      const draft = { tabId: draftId, target: { kind: "draft" as const, draftId }, createdAt: now };
      rebuiltTabs.unshift(draft);
      focusedTabId = draftId;
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

function findTemplatePaneRoles(layout: WorkspaceLayout): TemplatePaneRoles {
  let agentPaneId: string | null = null;
  let terminalPaneId: string | null = null;
  const panes = collectAllPanes(layout.root) as SplitPaneInternal[];
  for (const pane of panes) {
    if (
      agentPaneId === null &&
      pane.tabs.some((tab) => tab.target.kind === "agent" || tab.target.kind === "draft")
    ) {
      agentPaneId = pane.id;
    }
    if (terminalPaneId === null && pane.tabs.some((tab) => tab.target.kind === "terminal")) {
      terminalPaneId = pane.id;
    }
  }
  return { agentPaneId, terminalPaneId };
}

/**
 * Captures the workspace's current arrangement. Workspace-local session ids
 * are dropped, while agent and terminal pane roles are retained so a new
 * workspace can create fresh content in the same locations.
 */
export function buildLayoutTemplate(input: BuildLayoutTemplateInput): WorkspaceLayoutTemplate {
  const normalized = normalizeLayout(input.layout);
  const paneRoles = findTemplatePaneRoles(normalized);
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
    agentPaneId: paneRoles.agentPaneId,
    terminalPaneId: paneRoles.terminalPaneId,
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

/** Draft identities carry pending submissions as well as unsent composer state. */
function isAgentPaneTab(tab: WorkspaceTab): boolean {
  return tab.target.kind === "agent" || tab.target.kind === "draft";
}

/** Tabs that reference live workspace resources or drafts and survive a template apply. */
function isCarriedTab(tab: WorkspaceTab): boolean {
  const kind = tab.target.kind;
  return (
    isAgentPaneTab(tab) ||
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

function placeTabsInPane(
  node: SplitNodeInternal,
  paneId: string,
  tabs: WorkspaceTab[],
  replacePlaceholder = false,
): SplitNodeInternal {
  if (tabs.length === 0) {
    return node;
  }
  if (node.kind === "pane") {
    if (node.pane.id !== paneId) {
      return node;
    }
    const existingTabs = replacePlaceholder
      ? node.pane.tabs.filter((tab) => tab.target.kind !== "new_tab" && tab.target.kind !== "draft")
      : node.pane.tabs;
    const nextTabs = [...existingTabs, ...tabs];
    return {
      kind: "pane",
      pane: {
        id: node.pane.id,
        tabIds: nextTabs.map((tab) => tab.tabId),
        focusedTabId: replacePlaceholder ? (tabs[0]?.tabId ?? null) : node.pane.focusedTabId,
        tabs: nextTabs,
        ...(node.pane.hidden === true ? { hidden: true } : {}),
      },
    };
  }
  return {
    kind: "group",
    group: {
      id: node.group.id,
      direction: node.group.direction,
      children: node.group.children.map((child) =>
        placeTabsInPane(child, paneId, tabs, replacePlaceholder),
      ),
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

export interface ApplyWorkspaceLayoutTemplateResult {
  terminalPaneId: string | null;
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
  }) => ApplyWorkspaceLayoutTemplateResult | null;
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
          return null;
        }
        if (get().appliedByWorkspaceKey[workspaceKey]) {
          return null;
        }
        const layoutStore = useWorkspaceLayoutStore.getState();
        const existingLayout = layoutStore.layoutByWorkspace[workspaceKey] ?? null;
        if (!isUnshapedWorkspaceLayout(existingLayout)) {
          return null;
        }
        const instantiated = instantiateLayoutTemplate(template, now);
        const carriedTabs = existingLayout
          ? collectAllTabs(normalizeLayout(existingLayout).root).filter(isCarriedTab)
          : [];
        const carriedAgentTabs = carriedTabs.filter(isAgentPaneTab);
        const otherCarriedTabs = carriedTabs.filter((tab) => !isAgentPaneTab(tab));
        const templatePanes = collectAllPanes(instantiated.layout.root) as SplitPaneInternal[];
        const fallbackPaneId = selectTemplateTargetPaneId(instantiated.layout);
        const agentPaneId =
          templatePanes.find((pane) => pane.id === template.agentPaneId)?.id ??
          templatePanes.find((pane) => pane.tabs.some((tab) => tab.target.kind === "draft"))?.id ??
          fallbackPaneId;
        let layout = asInternalNode(instantiated.layout.root);
        // Carry the original draft unchanged: the submission and create-flow
        // stores are keyed by its draftId. A fresh template draft cannot submit it.
        layout = placeTabsInPane(layout, agentPaneId, carriedAgentTabs, true);
        layout = placeTabsInPane(layout, fallbackPaneId, otherCarriedTabs);
        layoutStore.seedWorkspaceLayout(workspaceKey, {
          layout: normalizeLayout({
            root: layout,
            focusedPaneId: agentPaneId,
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
        return { terminalPaneId: template.terminalPaneId ?? null };
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
  onTerminalPaneRequested?: (paneId: string) => void;
}

/** Seeds a newly opened workspace with its project's saved layout template. */
export function useApplyWorkspaceLayoutTemplate(input: ApplyWorkspaceLayoutTemplateInput): void {
  const layoutHydrated = useWorkspaceLayoutStoreHydrated();
  const templatesHydrated = useWorkspaceLayoutTemplateStoreHydrated();
  const applyTemplateToWorkspace = useWorkspaceLayoutTemplateStore(
    (state) => state.applyTemplateToWorkspace,
  );
  const { enabled, onTerminalPaneRequested, projectRootPath, workspaceKey } = input;

  useEffect(() => {
    if (
      !enabled ||
      workspaceKey === null ||
      projectRootPath === null ||
      !layoutHydrated ||
      !templatesHydrated
    ) {
      return;
    }
    const result = applyTemplateToWorkspace({
      workspaceKey,
      projectRootPath,
      now: Date.now(),
    });
    if (result?.terminalPaneId) {
      onTerminalPaneRequested?.(result.terminalPaneId);
    }
  }, [
    applyTemplateToWorkspace,
    enabled,
    layoutHydrated,
    onTerminalPaneRequested,
    projectRootPath,
    templatesHydrated,
    workspaceKey,
  ]);
}
