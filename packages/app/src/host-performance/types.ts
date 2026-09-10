import type { HostPerformanceSnapshot } from "@getpaseo/protocol/host-performance";

export type HostPerformanceView =
  | { kind: "loading" }
  | { kind: "error"; message: string; canRetry: boolean; isRetrying: boolean }
  | { kind: "unsupported"; message: string }
  | {
      kind: "ready";
      snapshot: HostPerformanceSnapshot;
      isRefreshing: boolean;
      isStale: boolean;
    };
