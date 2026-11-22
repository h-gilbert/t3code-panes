import { defaultParseSearch } from "@tanstack/react-router";

export function stripDelegatedCaptureSuffix(value: string): string {
  return value.replace(/(?:\?browserCapture=delegated)+$/, "");
}

export function parseDelegatedDesktopSearch(search: string): Record<string, unknown> {
  // Hash history appends the desktop shell's outer query to the route's query.
  const parsed = defaultParseSearch(stripDelegatedCaptureSuffix(search)) as Record<string, unknown>;
  if (typeof parsed.workspace === "string") {
    parsed.workspace = stripDelegatedCaptureSuffix(parsed.workspace);
  }
  return parsed;
}
