export function readSideSelection(scopeId: string): string | null {
  const scope = document.getElementById(scopeId);
  const selection = window.getSelection();
  if (!scope || !selection?.anchorNode || !selection.focusNode) return null;
  if (!scope.contains(selection.anchorNode) || !scope.contains(selection.focusNode)) return null;
  const text = selection.toString();
  return text.trim() ? text : null;
}
