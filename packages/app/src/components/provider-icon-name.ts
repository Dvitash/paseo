import {
  BUILTIN_PROVIDER_ICON_NAMES,
  KNOWN_PROVIDER_ICON_NAMES,
} from "@getpaseo/protocol/provider-icon-names";
import type { ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";

export type ProviderIconName =
  | { kind: "builtin"; id: string }
  | { kind: "catalog"; id: string }
  | { kind: "svg"; svg: string }
  | { kind: "bot" };

const BUILTIN_PROVIDER_IDS = new Set([...BUILTIN_PROVIDER_ICON_NAMES, "devin"]);
const KNOWN_PROVIDER_IDS = new Set(KNOWN_PROVIDER_ICON_NAMES);
const providerSnapshotIconSvgsByServer = new Map<string, ReadonlyMap<string, string>>();
export const OMP_PROVIDER_ICON_ALIASES: Record<string, string> = {
  anthropic: "claude",
  "anthropic-claude": "claude",
  "openai-codex": "codex",
  openai: "codex",
  "github-copilot": "copilot",
  "google-antigravity": "agy",
  antigravity: "agy",
  google: "gemini",
  "kimi-code": "kimi",
  "opencode-go": "opencode",
  "minimax-code": "minimax",
};

export function replaceProviderSnapshotIcons(
  serverId: string,
  entries: readonly Pick<ProviderSnapshotEntry, "provider" | "iconSvg">[],
): void {
  const icons = new Map<string, string>();
  for (const entry of entries) {
    if (entry.iconSvg) {
      icons.set(entry.provider, entry.iconSvg);
    }
  }
  providerSnapshotIconSvgsByServer.set(serverId, icons);
}

export function resolveProviderIconName(
  provider: string,
  serverId?: string | null,
): ProviderIconName {
  const canonical = OMP_PROVIDER_ICON_ALIASES[provider] ?? provider;
  if (BUILTIN_PROVIDER_IDS.has(canonical)) {
    return { kind: "builtin", id: canonical };
  }
  const iconSvg = serverId
    ? (providerSnapshotIconSvgsByServer.get(serverId)?.get(provider) ??
      providerSnapshotIconSvgsByServer.get(serverId)?.get(canonical))
    : undefined;
  if (iconSvg) {
    return { kind: "svg", svg: iconSvg };
  }
  if (KNOWN_PROVIDER_IDS.has(canonical)) {
    return { kind: "catalog", id: canonical };
  }
  return { kind: "bot" };
}
