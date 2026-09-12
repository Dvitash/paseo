/** Counts document lines the way `content.split("\n").length` does, without the array. */
export function countContentLines(content: string): number {
  let lines = 1;
  for (let index = content.indexOf("\n"); index !== -1; index = content.indexOf("\n", index + 1)) {
    lines += 1;
  }
  return lines;
}
