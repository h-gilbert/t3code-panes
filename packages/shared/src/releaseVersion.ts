/** Versions published by the upstream release pipeline. Local builds need local promotion. */
export function isPublishedT3Version(version: string): boolean {
  return /^\d+\.\d+\.\d+(?:-nightly\.\d{8}\.\d+)?$/u.test(version.trim());
}

/** Where `vp run release:panes` publishes this fork's releases. */
export const FORK_RELEASE_REPOSITORY = "h-gilbert/t3code-panes";

/**
 * Releases of this fork (`<upstream core>-panes.<timestamp>`). They update only
 * from the fork's own releases, so custom behavior is never replaced by a stock
 * build. Local promotion builds carry an extra digest and stay local.
 */
export function isForkReleaseVersion(version: string): boolean {
  return /^\d+\.\d+\.\d+-panes\.\d{13}$/u.test(version.trim());
}

/** Versions whose desktop app and server can update themselves from a release feed. */
export function isSelfUpdatableT3Version(version: string): boolean {
  return isPublishedT3Version(version) || isForkReleaseVersion(version);
}
