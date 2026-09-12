/**
 * Keeps the icon data array identity stable across renders when every entry still resolves to the
 * same URI. Comparing elements directly avoids joining megabytes of base64 just to compare it.
 */
export function stableIconData(
  previous: readonly (string | null)[],
  next: readonly (string | null)[],
): readonly (string | null)[] {
  if (previous.length !== next.length) return next;
  for (let index = 0; index < next.length; index += 1) {
    if (previous[index] !== next[index]) return next;
  }
  return previous;
}
