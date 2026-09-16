import { useStableEvent } from "@/hooks/use-stable-event";
import React, {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useId,
  type ReactNode,
} from "react";
import { Text, View } from "react-native";
import type { SideChatReference } from "@getpaseo/protocol/side";
import { Button } from "@/components/ui/button";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";
import { openExplorerSidebarView } from "@/workspace-tabs/explorer-sidebar";
import { EMPTY_SIDE_DRAFT, sideSessionKey, useSideWorkspaceStore } from "./state";
import { readSideSelection } from "./selection";
import { styles } from "./styles";

interface SideReferenceScope {
  serverId: string;
  workspaceId: string;
  mainAgentId: string | null;
  cwd: string;
  scopeId: string;
  available: boolean;
  isCompact: boolean;
}
const SideReferenceContext = createContext<SideReferenceScope | null>(null);
interface SideReferenceProviderProps {
  children: ReactNode;
  serverId: string;
  workspaceId: string;
  mainAgentId?: string;
  cwd: string;
}
export function SideReferenceProvider({
  children,
  serverId,
  workspaceId,
  mainAgentId,
  cwd,
}: SideReferenceProviderProps) {
  const scopeId = `side-source-${useId()}`;
  const client = useHostRuntimeClient(serverId);
  const workspaceKey = buildWorkspaceTabPersistenceKey({ serverId, workspaceId });
  const remembered = useSideWorkspaceStore((state) =>
    workspaceKey ? (state.pins[workspaceKey] ?? state.lastMain[workspaceKey] ?? null) : null,
  );
  const active = useRetainedPanelActive();
  const isCompact = useIsCompactFormFactor();
  const available = client?.getLastServerInfoMessage()?.features?.sideChatV2 === true;
  const targetId = mainAgentId ?? remembered;
  useEffect(() => {
    if (active && mainAgentId && workspaceKey)
      useSideWorkspaceStore.getState().rememberMain(workspaceKey, mainAgentId);
  }, [active, mainAgentId, workspaceKey]);
  const value = useMemo<SideReferenceScope>(
    () => ({ serverId, workspaceId, mainAgentId: targetId, cwd, scopeId, available, isCompact }),
    [serverId, workspaceId, targetId, cwd, scopeId, available, isCompact],
  );
  return (
    <SideReferenceContext.Provider value={value}>
      <View nativeID={scopeId} style={styles.container}>
        {children}
      </View>
    </SideReferenceContext.Provider>
  );
}
interface AskSideButtonProps {
  getContent: () => string;
  kind?: SideChatReference["kind"];
  label?: string;
  messageId?: string;
  path?: string;
}
export function AskSideButton({
  getContent,
  kind = "message",
  label = "Main response",
  messageId,
  path,
}: AskSideButtonProps) {
  const scope = useContext(SideReferenceContext);
  const selected = useRef<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mainAgentId = scope?.mainAgentId;
  const ask = useStableEvent(() => {
    if (!scope || !mainAgentId) return;
    const selection = selected.current ?? readSideSelection(scope.scopeId);
    selected.current = null;
    const text = selection ?? getContent();
    if (!text.trim()) return;
    const workspaceKey = buildWorkspaceTabPersistenceKey(scope);
    if (!workspaceKey) return;
    const store = useSideWorkspaceStore.getState();
    const key = sideSessionKey(scope.serverId, mainAgentId);
    const draft = store.drafts[key] ?? EMPTY_SIDE_DRAFT;
    if (draft.references.length >= 4) {
      setError("Remove a Side reference before adding another.");
      return;
    }
    const clipped = text.length > 12_000;
    const reference: SideChatReference = {
      id: crypto.randomUUID(),
      kind: selection ? "selection" : kind,
      label: `${label}${selection ? " · selection" : ""}${clipped ? " · excerpt" : ""}`.slice(
        0,
        240,
      ),
      text: clipped ? `${text.slice(0, 11_960)}\n[Reference excerpt truncated]` : text,
      agentId: mainAgentId,
      messageId,
      path,
    };
    store.updateDraft(key, { references: [...draft.references, reference] });
    store.pin(workspaceKey, mainAgentId);
    store.rememberMain(workspaceKey, mainAgentId);
    openExplorerSidebarView({
      isCompact: scope.isCompact,
      workspaceKey,
      checkout: { serverId: scope.serverId, cwd: scope.cwd, isGit: true },
      view: "side",
    });
    setError(null);
  });
  const captureSelection = useStableEvent(() => {
    if (scope) selected.current = readSideSelection(scope.scopeId);
  });
  if (!scope?.mainAgentId || !scope.available) return null;
  return (
    <View>
      <Button
        size="sm"
        variant="ghost"
        accessibilityLabel="Ask Side about this"
        onPressIn={captureSelection}
        onPress={ask}
        testID="ask-side-about-this"
      >
        Ask Side
      </Button>
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </View>
  );
}
