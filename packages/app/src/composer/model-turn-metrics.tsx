import { memo, useRef } from "react";
import { Text } from "react-native";
import { useTranslation } from "react-i18next";
import type { AgentUsage } from "@getpaseo/protocol/agent-types";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { composerPillStyles } from "@/composer/pill-styles";
import {
  createThreadTokenUsageAccumulator,
  getThreadTokenUsage,
  hasTokenUsage,
  updateThreadTokenUsage,
  type TokenUsageValues,
  type ThreadTokenUsageAccumulator,
} from "@/composer/thread-token-usage";
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
  const usage = useSessionStore((state) => state.sessions[serverId]?.agents.get(agentId)?.lastUsage);
  const turnKey = useSessionStore((state) => {
    const lastUserMessageAt = state.sessions[serverId]?.agents.get(agentId)?.lastUserMessageAt;
    return lastUserMessageAt?.getTime() ?? null;
  });
  const scopeKey = `${serverId}:${agentId}`;
  const trackerRef = useRef<{
    scopeKey: string;
    accumulator: ThreadTokenUsageAccumulator;
  }>({
    scopeKey,
    accumulator: createThreadTokenUsageAccumulator(),
  });
  if (trackerRef.current.scopeKey !== scopeKey) {
    trackerRef.current = {
      scopeKey,
      accumulator: createThreadTokenUsageAccumulator(),
    };
  }
  trackerRef.current.accumulator = updateThreadTokenUsage(
    trackerRef.current.accumulator,
    turnKey,
    usage,
  );

  const metrics = usage?.modelTurn;
  if (!metrics) return null;
  const threadUsage = getThreadTokenUsage(trackerRef.current.accumulator);

  return (
    <>
      <ModelTurnMetricsPill metrics={metrics} />
      {hasTokenUsage(threadUsage) ? <ThreadTokenUsagePill usage={threadUsage} /> : null}
    </>
  );
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

function formatTokenCount(value: number | undefined): string {
  if (value === undefined) return "—";
  if (value < 1_000) return Math.round(value).toLocaleString();
  if (value < 1_000_000) {
    const digits = value < 10_000 ? 1 : 0;
    return `${(value / 1_000).toFixed(digits)}k`;
  }
  const digits = value < 10_000_000 ? 1 : 0;
  return `${(value / 1_000_000).toFixed(digits)}m`;
}

export function ThreadTokenUsagePill({ usage }: { usage: TokenUsageValues }) {
  const input = formatTokenCount(usage.inputTokens);
  const cached = formatTokenCount(usage.cachedInputTokens);
  const output = formatTokenCount(usage.outputTokens);
  const label = `In ${input} · Cache ${cached} · Out ${output}`;

  return (
    <Tooltip enabledOnMobile>
      <TooltipTrigger
        testID="composer-thread-token-usage-pill"
        style={composerPillStyles.body}
        accessibilityLabel={`Current thread token usage. Input ${input}. Cached ${cached}. Output ${output}.`}
      >
        <Text style={composerPillStyles.label}>{label}</Text>
      </TooltipTrigger>
      <TooltipContent>Current thread token usage</TooltipContent>
    </Tooltip>
  );
}
