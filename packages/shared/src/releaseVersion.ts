/** Versions published by the upstream release pipeline. Local builds need local promotion. */
export function isPublishedT3Version(version: string): boolean {
  return /^\d+\.\d+\.\d+(?:-nightly\.\d{8}\.\d+)?$/u.test(version.trim());
}
