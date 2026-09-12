import { existsSync, promises as fsPromises, readFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Logger } from "pino";
import { z } from "zod";
import type { ProviderUsage, ProviderUsageWindow } from "../../server/messages.js";
import { toneFromUsedPct } from "./usage.js";

const OmpLimitAmountSchema = z
  .object({
    used: z.number().finite().optional(),
    limit: z.number().finite().optional(),
    remaining: z.number().finite().optional(),
    remainingFraction: z.number().finite().optional(),
    usedFraction: z.number().finite().optional(),
    unit: z.string().optional(),
  })
  .passthrough();

const OmpLimitSchema = z
  .object({
    id: z.string().optional(),
    label: z.string().optional(),
    amount: OmpLimitAmountSchema.optional(),
    status: z.string().optional(),
  })
  .passthrough();

const OmpReportMetadataSchema = z
  .object({
    email: z.string().optional(),
    projectId: z.string().optional(),
    accountId: z.string().optional(),
    planType: z.string().optional(),
    tier: z.string().optional(),
    tierName: z.string().optional(),
  })
  .passthrough();

export const OmpReportSchema = z
  .object({
    provider: z.string().min(1),
    account: z.string().optional(),
    fetchedAt: z.number().finite().optional(),
    limits: z.array(OmpLimitSchema).optional(),
    metadata: OmpReportMetadataSchema.optional(),
    error: z.string().optional(),
    status: z.string().optional(),
  })
  .passthrough();

const OmpAccountWithoutUsageSchema = z.union([
  z.string().min(1),
  z
    .object({
      provider: z.string().min(1),
    })
    .passthrough(),
]);

export const OmpUsageCacheSchema = z
  .object({
    generatedAt: z.number().finite(),
    reports: z.array(OmpReportSchema),
    accountsWithoutUsage: z.array(OmpAccountWithoutUsageSchema).optional(),
    disabledCredentials: z.array(z.unknown()).optional(),
    capacity: z
      .record(
        z.string(),
        z.array(
          z
            .object({
              accounts: z.number().finite(),
              remainingAccounts: z.number().finite(),
            })
            .passthrough(),
        ),
      )
      .optional(),
  })
  .passthrough();

export const AccountWeightsSchema = z
  .object({
    tiers: z.record(z.string(), z.number().finite()).optional(),
    accounts: z.record(z.string(), z.number().finite()).optional(),
  })
  .passthrough();

type OmpLimitAmount = z.infer<typeof OmpLimitAmountSchema>;
export type OmpLimit = z.infer<typeof OmpLimitSchema>;
export type OmpReport = z.infer<typeof OmpReportSchema>;
export type OmpUsageData = z.infer<typeof OmpUsageCacheSchema>;
export type AccountWeightsConfig = z.infer<typeof AccountWeightsSchema>;

export interface ProviderUsageListResult {
  fetchedAt: string;
  providers: ProviderUsage[];
}

export interface OmpUsageCacheOptions {
  cachePath?: string;
  accountWeightsPath?: string;
  agentDbPath?: string;
  now?: () => number;
  logger?: Logger;
  staleThresholdMs?: number;
}

export const STALE_CACHE_THRESHOLD_MS = 5 * 60 * 1000;

export const DEFAULT_ACCOUNT_WEIGHTS: AccountWeightsConfig = {
  tiers: {
    ultra: 20,
    "ultra-250": 20,
    pro: 1,
    free: 1,
    spark: 1,
  },
};

const DEFAULT_OMP_CACHE_PATH = path.join(os.homedir(), ".omp", "agent", "usage-cache.json");
const DEFAULT_ACCOUNT_WEIGHTS_PATH = path.join(
  os.homedir(),
  ".omp",
  "agent",
  "account-weights.json",
);
const DEFAULT_OMP_AGENT_DB_PATH = path.join(os.homedir(), ".omp", "agent", "agent.db");

const KNOWN_PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  "google-antigravity": "Google Antigravity",
  "openai-codex": "OpenAI Codex",
  "opencode-go": "OpenCode Go",
  anthropic: "Claude",
  "github-copilot": "GitHub Copilot",
  "kimi-code": "Kimi",
  commandcode: "Command Code",
  "opencode-zen": "OpenCode Zen",
  openrouter: "OpenRouter",
  cursor: "Cursor",
  devin: "Devin",
  claude: "Claude",
  codex: "Codex",
  copilot: "Copilot",
  grok: "Grok",
  kimi: "Kimi",
  minimax: "MiniMax",
  zai: "Zai",
  omp: "OMP",
};

// OMP keeps the authoritative subscription list in agent.db's auth_credentials
// table. A freshly added provider has a credential row before the usage cache
// ever reports on it, so the sidebar would otherwise hide it entirely.
// Read provider names only — never the credential payloads.
interface OmpAgentDbStatement {
  all(...params: unknown[]): Record<string, unknown>[];
}
interface OmpAgentDb {
  prepare(sql: string): OmpAgentDbStatement;
  close(): void;
}
interface NodeSqliteModule {
  DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => OmpAgentDb;
}

export async function listOmpCredentialProviders(
  agentDbPath?: string,
  logger?: Logger,
): Promise<string[]> {
  const resolvedPath =
    agentDbPath ?? process.env.PASEO_OMP_AGENT_DB_PATH ?? DEFAULT_OMP_AGENT_DB_PATH;
  if (!existsSync(resolvedPath)) {
    return [];
  }

  // @types/node@20 predates node:sqlite typings; same narrow declaration as the
  // Cursor fetcher uses for state.vscdb.
  const sqliteSpecifier: string = "node:sqlite";
  let sqlite: NodeSqliteModule;
  try {
    sqlite = (await import(sqliteSpecifier)) as unknown as NodeSqliteModule;
  } catch (err) {
    logger?.debug({ err }, "node:sqlite unavailable; cannot read OMP agent.db");
    return [];
  }

  let db: OmpAgentDb | undefined;
  try {
    db = new sqlite.DatabaseSync(resolvedPath, { readOnly: true });
    const rows = db
      .prepare("SELECT DISTINCT provider FROM auth_credentials WHERE disabled_cause IS NULL")
      .all();
    const providers: string[] = [];
    for (const row of rows) {
      const provider = row["provider"];
      if (typeof provider === "string" && provider.trim()) {
        providers.push(provider.trim());
      }
    }
    return providers;
  } catch (err) {
    logger?.debug({ err, path: resolvedPath }, "Failed to read OMP credential providers");
    return [];
  } finally {
    db?.close();
  }
}

function credentialOnlyUsage(providerId: string, fetchedAtMs: number): ProviderUsage {
  return {
    providerId,
    displayName: formatProviderDisplayName(providerId),
    status: "unavailable",
    planLabel: null,
    sourceLabel: "OMP",
    fetchedAt: new Date(fetchedAtMs).toISOString(),
    windows: [
      {
        id: "omp-rollup",
        label: "Usage",
        usedPct: null,
        remainingPct: null,
      },
    ],
    balances: [],
    details: [],
    error: null,
  };
}

function mergeCredentialProviders(
  providers: ProviderUsage[],
  credentialProviders: readonly string[],
  fetchedAtMs: number,
): ProviderUsage[] {
  const known = new Set(providers.map((provider) => provider.providerId));
  const merged = [...providers];
  for (const providerId of credentialProviders) {
    if (!providerId || known.has(providerId)) continue;
    merged.push(credentialOnlyUsage(providerId, fetchedAtMs));
    known.add(providerId);
  }
  return merged;
}

export function loadAccountWeights(weightsPath?: string): AccountWeightsConfig {
  const resolvedPath =
    weightsPath ?? process.env.PASEO_OMP_ACCOUNT_WEIGHTS_PATH ?? DEFAULT_ACCOUNT_WEIGHTS_PATH;
  if (!existsSync(resolvedPath)) {
    return DEFAULT_ACCOUNT_WEIGHTS;
  }

  let raw: string;
  try {
    raw = readFileSync(resolvedPath, "utf8");
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to read account weights at ${resolvedPath}: ${message}`, {
      cause: err,
    });
  }

  const clean = raw.replace(/^\uFEFF/, "").trim();
  if (!clean) {
    throw new Error(`Malformed account weights at ${resolvedPath}: file is empty`);
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(clean);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Malformed account weights at ${resolvedPath}: ${message}`, { cause: err });
  }

  let validated: AccountWeightsConfig;
  try {
    validated = AccountWeightsSchema.parse(parsedJson);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Malformed account weights at ${resolvedPath}: validation failed - ${message}`,
      {
        cause: err,
      },
    );
  }

  return {
    tiers: { ...DEFAULT_ACCOUNT_WEIGHTS.tiers, ...validated.tiers },
    accounts: validated.accounts ?? {},
  };
}

function reportPlan(report: OmpReport): string | undefined {
  const metadata = report.metadata;
  const plan = metadata?.planType ?? metadata?.tier ?? metadata?.tierName;
  return plan?.trim() || undefined;
}

export function getReportWeight(report: OmpReport, weightsConfig?: AccountWeightsConfig): number {
  const meta = report.metadata ?? {};
  const email = meta.email ?? report.account;
  const projectId = meta.projectId;
  const accountId = meta.accountId;
  const planType = reportPlan(report);

  const tiers = { ...DEFAULT_ACCOUNT_WEIGHTS.tiers, ...weightsConfig?.tiers };
  const accounts = weightsConfig?.accounts ?? {};

  if (typeof planType === "string" && planType.trim()) {
    const lowerPlan = planType.toLowerCase();
    const sortedTiers = Object.entries(tiers).sort((a, b) => b[0].length - a[0].length);
    for (const [tierKey, weight] of sortedTiers) {
      if (typeof weight === "number" && tierKey && lowerPlan.includes(tierKey.toLowerCase())) {
        return weight;
      }
    }
  }

  for (const key of [email, projectId, accountId]) {
    if (typeof key === "string" && key && typeof accounts[key] === "number") {
      return accounts[key]!;
    }
  }

  return 1;
}

export function formatProviderDisplayName(providerId: string): string {
  const matched = KNOWN_PROVIDER_DISPLAY_NAMES[providerId];
  if (matched) return matched;
  return providerId
    .split(/[-_]/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function computeLimitRemainingFraction(amount: OmpLimitAmount): number | undefined {
  if (typeof amount.remainingFraction === "number") {
    return amount.remainingFraction;
  }
  if (typeof amount.remaining === "number") {
    const cap = typeof amount.limit === "number" && amount.limit > 0 ? amount.limit : 100;
    return cap > 0 ? amount.remaining / cap : 0;
  }
  if (typeof amount.usedFraction === "number") {
    return 1 - amount.usedFraction;
  }
  if (typeof amount.used === "number" && typeof amount.limit === "number" && amount.limit > 0) {
    return 1 - amount.used / amount.limit;
  }
  return undefined;
}

function resolveBindingLimit(limits?: OmpLimit[]): number | undefined {
  if (!Array.isArray(limits)) return undefined;
  let binding: number | undefined;
  for (const limit of limits) {
    const amount = limit?.amount;
    if (!amount) continue;
    const isSpark =
      (limit.id ?? "").toLowerCase().includes("spark") ||
      (limit.label ?? "").toLowerCase().includes("spark");
    if (isSpark) continue;

    const rem = computeLimitRemainingFraction(amount);
    if (rem === undefined) continue;
    const clamped = Math.max(0, Math.min(1, rem));
    if (binding === undefined || clamped < binding) {
      binding = clamped;
    }
  }
  return binding;
}

function assembleProviderGroup(
  providerId: string,
  reports: OmpReport[],
  validatedGeneratedAt: number,
  config: AccountWeightsConfig,
  isCacheStale: boolean,
  staleThresholdMs: number,
  nowMs: number,
): ProviderUsage {
  let totalWeight = 0;
  let weightedRemaining = 0;
  let validLimitsCount = 0;
  let hasErrorReport = false;
  let hasStaleReport = false;
  let oldestFetchedAt: number | undefined;
  let rawPlan: string | undefined;

  for (const report of reports) {
    if (typeof report.fetchedAt === "number") {
      if (nowMs - report.fetchedAt > staleThresholdMs) {
        hasStaleReport = true;
      }
      oldestFetchedAt =
        oldestFetchedAt === undefined
          ? report.fetchedAt
          : Math.min(oldestFetchedAt, report.fetchedAt);
    }

    if (report.error || report.status === "error") {
      hasErrorReport = true;
    }

    rawPlan ??= reportPlan(report);

    const binding = resolveBindingLimit(report.limits);
    if (binding !== undefined) {
      const weight = Math.max(0.001, getReportWeight(report, config));
      totalWeight += weight;
      weightedRemaining += weight * binding;
      validLimitsCount += 1;
    }
  }

  const fetchedAtIso = new Date(oldestFetchedAt ?? validatedGeneratedAt).toISOString();
  const planLabel = rawPlan ? rawPlan.charAt(0).toUpperCase() + rawPlan.slice(1) : null;
  const displayName = formatProviderDisplayName(providerId);

  let status: ProviderUsage["status"];
  let error: string | null = null;
  let usedPct: number | null = null;
  let remainingPct: number | null = null;

  if (hasErrorReport) {
    status = "error";
    error = "Provider quota fetch failed";
  } else if (validLimitsCount === 0) {
    status = "unavailable";
  } else if (validLimitsCount < reports.length) {
    status = "error";
    error = "Provider usage contains failed or unavailable account data";
  } else {
    status = "available";
    remainingPct = Math.min(100, Math.max(0, Math.round((weightedRemaining / totalWeight) * 100)));
    usedPct = 100 - remainingPct;
  }

  const isStale = isCacheStale || hasStaleReport;
  const sourceLabel = isStale && status === "available" ? "OMP (cached)" : "OMP";

  const window: ProviderUsageWindow = {
    id: "omp-rollup",
    label: "Usage",
    usedPct,
    remainingPct,
    tone: usedPct === null ? undefined : toneFromUsedPct(usedPct),
  };

  return {
    providerId,
    displayName,
    status,
    planLabel,
    sourceLabel,
    fetchedAt: fetchedAtIso,
    windows: [window],
    balances: [],
    details: [],
    error,
  };
}

export function parseOmpUsage(
  data: OmpUsageData,
  weightsConfig?: AccountWeightsConfig,
  options?: { nowMs?: number; staleThresholdMs?: number },
): ProviderUsage[] {
  const validated = OmpUsageCacheSchema.parse(data);
  const nowMs = options?.nowMs ?? Date.now();
  const staleThresholdMs = options?.staleThresholdMs ?? STALE_CACHE_THRESHOLD_MS;
  const config = weightsConfig ?? DEFAULT_ACCOUNT_WEIGHTS;

  const isCacheStale = nowMs - validated.generatedAt > staleThresholdMs;

  const groups = new Map<string, OmpReport[]>();
  for (const report of validated.reports) {
    const providerId = report.provider.trim();
    const list = groups.get(providerId) ?? [];
    list.push(report);
    groups.set(providerId, list);
  }

  const providers: ProviderUsage[] = [];

  for (const [providerId, reports] of groups.entries()) {
    providers.push(
      assembleProviderGroup(
        providerId,
        reports,
        validated.generatedAt,
        config,
        isCacheStale,
        staleThresholdMs,
        nowMs,
      ),
    );
  }

  if (Array.isArray(validated.accountsWithoutUsage)) {
    for (const entry of validated.accountsWithoutUsage) {
      const providerId = (typeof entry === "string" ? entry : entry.provider).trim();
      if (!providerId || groups.has(providerId)) continue;
      const window: ProviderUsageWindow = {
        id: "omp-rollup",
        label: "Usage",
        usedPct: null,
        remainingPct: null,
      };
      providers.push({
        providerId,
        displayName: formatProviderDisplayName(providerId),
        status: "unavailable",
        planLabel: null,
        sourceLabel: "OMP",
        fetchedAt: new Date(validated.generatedAt).toISOString(),
        windows: [window],
        balances: [],
        details: [],
        error: null,
      });
      groups.set(providerId, []);
    }
  }

  return providers;
}

async function readOmpUsageCacheData(cachePath: string): Promise<OmpUsageData | null> {
  let raw: string;
  try {
    raw = await fsPromises.readFile(cachePath, "utf8");
  } catch (err: unknown) {
    if (typeof err === "object" && err !== null && "code" in err && err.code === "ENOENT") {
      return null;
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to read OMP usage cache at ${cachePath}: ${message}`, { cause: err });
  }

  const cleanRaw = raw.replace(/^\uFEFF/, "").trim();
  if (!cleanRaw) {
    throw new Error(`Malformed OMP usage cache at ${cachePath}: file is empty`);
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(cleanRaw);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Malformed OMP usage cache at ${cachePath}: ${message}`, { cause: err });
  }

  try {
    return OmpUsageCacheSchema.parse(parsedJson);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Malformed OMP usage cache at ${cachePath}: validation failed - ${message}`, {
      cause: err,
    });
  }
}

export async function readOmpUsage(
  options?: OmpUsageCacheOptions,
): Promise<ProviderUsageListResult> {
  const cachePath =
    options?.cachePath ?? process.env.PASEO_OMP_USAGE_CACHE_PATH ?? DEFAULT_OMP_CACHE_PATH;
  const nowMs = (options?.now ?? Date.now)();

  const credentialProviders = await listOmpCredentialProviders(
    options?.agentDbPath,
    options?.logger,
  );

  const data = await readOmpUsageCacheData(cachePath);
  if (data === null) {
    return {
      fetchedAt: new Date(nowMs).toISOString(),
      providers: mergeCredentialProviders([], credentialProviders, nowMs),
    };
  }

  const weights = loadAccountWeights(options?.accountWeightsPath);
  const providers = parseOmpUsage(data, weights, {
    nowMs,
    staleThresholdMs: options?.staleThresholdMs,
  });

  return {
    fetchedAt: new Date(data.generatedAt).toISOString(),
    providers: mergeCredentialProviders(providers, credentialProviders, data.generatedAt),
  };
}
