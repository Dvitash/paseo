import { memo } from "react";
import { Text } from "react-native";
import { useTranslation } from "react-i18next";
import type { AgentUsage } from "@getpaseo/protocol/agent-types";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { composerPillStyles } from "@/composer/pill-styles";
import { useSessionStore } from "@/stores/session-store";

export function useHasModelTurnMetrics(serverId: string, agentId: string): boolean {
  return useSessionStore((state) => {
    const session = state.sessions[serverId];
    return (
      session?.serverInfo?.features?.modelTurnMetrics === true &&
      session.agents.get(agentId)?.lastUsage?.modelTurn !== undefined
    );
  });
}

export const AgentModelTurnMetricsPill = memo(function AgentModelTurnMetricsPill({
  serverId,
  agentId,
}: {
  serverId: string;
  agentId: string;
}) {
  const metrics = useSessionStore(
    (state) => state.sessions[serverId]?.agents.get(agentId)?.lastUsage?.modelTurn,
  );
  if (!metrics) return null;
  return <ModelTurnMetricsPill metrics={metrics} />;
});

export function ModelTurnMetricsPill({
  metrics,
}: {
  metrics: NonNullable<AgentUsage["modelTurn"]>;
}) {
  const { t } = useTranslation();
  const ttft = metrics.ttftMs === null ? "—" : `${(metrics.ttftMs / 1000).toFixed(2)}s`;
  const tps = metrics.tokensPerSecond === null ? "—" : metrics.tokensPerSecond.toFixed(1);
  const label = `TTFT ${ttft} · TPS ${tps}`;
  const turnLabel =
    metrics.status === "running"
      ? t("composer.modelTurnMetrics.current")
      : t("composer.modelTurnMetrics.previous");
  const description = t("composer.modelTurnMetrics.description");

  return (
    <Tooltip enabledOnMobile>
      <TooltipTrigger
        testID="composer-model-turn-metrics-pill"
        style={composerPillStyles.body}
        accessibilityLabel={`${turnLabel}. ${label}. ${description}`}
      >
        <Text style={composerPillStyles.label}>{label}</Text>
      </TooltipTrigger>
      <TooltipContent>{`${turnLabel}. ${description}`}</TooltipContent>
    </Tooltip>
  );
}
