/**
 * Avatar letter: the first letter of the name after the longest session prefix it
 * starts with. Every prefix ever set counts, so changing the prefix doesn't turn
 * older sessions into a column of identical letters.
 */
export function displayInitialFor(name: string, prefixes: readonly string[]): string {
  const lower = name.toLowerCase();
  const prefix = prefixes
    .filter((p) => p && lower.startsWith(p.toLowerCase()))
    .sort((a, b) => b.length - a.length)[0] ?? "";
  const rest = name.slice(prefix.length).replace(/^[-_\s]+/, "");
  return ((rest || name).trim()[0] || name[0] || "?").toUpperCase();
}

/** Add `prefix` to the remembered list (newest first, at most 20), returning the new list. */
export function rememberPrefix(known: readonly string[], prefix: string): string[] {
  if (!prefix) return [...known];
  return [prefix, ...known.filter((p) => p.toLowerCase() !== prefix.toLowerCase())].slice(0, 20);
}
