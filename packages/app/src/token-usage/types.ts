import type {
  HostTokenUsageRangeItem,
  HostTokenUsageRanges,
} from "@getpaseo/protocol/host-token-usage";

export type TimeRangeKey = "1h" | "24h" | "7d" | "30d" | "all";

export type TokenUsageView =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "unavailable"; message: string }
  | {
      kind: "ready";
      ranges: HostTokenUsageRanges;
      fetchedAt: string;
      isRefreshing: boolean;
    };

export type { HostTokenUsageRangeItem, HostTokenUsageRanges };
