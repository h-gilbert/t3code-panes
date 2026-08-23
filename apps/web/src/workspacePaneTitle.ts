interface ThreadTitleSource {
  readonly title: string;
}

export function resolveWorkspacePaneThreadTitle(
  detail: ThreadTitleSource | null,
  shell: ThreadTitleSource | null,
): string | null {
  return shell?.title ?? detail?.title ?? null;
}
