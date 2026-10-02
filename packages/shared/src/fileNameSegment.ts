/**
 * Reduces a page- or agent-supplied file name to one safe path segment: the
 * last path component, without control characters, capped at 200 characters.
 */
export const safeFileNameSegment = (name: string, fallback = "file"): string => {
  const base = name.split(/[\\/]/).at(-1) ?? "";
  const printable = Array.from(base)
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code > 0x1f && code !== 0x7f;
    })
    .join("")
    .trim()
    .slice(0, 200);
  return printable === "" || printable === "." || printable === ".." ? fallback : printable;
};
