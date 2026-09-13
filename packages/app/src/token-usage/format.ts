export function formatTokenStat(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value) || value <= 0) {
    return "0";
  }
  if (value >= 1_000_000_000) {
    const b = value / 1_000_000_000;
    return `${b >= 10 ? Math.round(b) : b.toFixed(1).replace(/\.0$/, "")}B`;
  }
  if (value >= 1_000_000) {
    const m = value / 1_000_000;
    return `${m >= 10 ? Math.round(m) : m.toFixed(1).replace(/\.0$/, "")}M`;
  }
  if (value >= 1_000) {
    const k = value / 1_000;
    return `${k >= 10 ? Math.round(k) : k.toFixed(1).replace(/\.0$/, "")}K`;
  }
  return Math.round(value).toString();
}
