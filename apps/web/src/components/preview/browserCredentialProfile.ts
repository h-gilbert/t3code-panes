import { DEFAULT_BROWSER_PROFILE_ID } from "@t3tools/contracts";

/** Legacy scopes retain their saved logins; managed profiles have separate identities. */
export function browserCredentialProfile(
  snapshot:
    | {
        readonly browserScope?: string | null | undefined;
        readonly profileId?: string | undefined;
      }
    | null
    | undefined,
): { profile: string | null; profileId?: string | undefined } {
  if (snapshot?.browserScope) {
    return {
      profile: snapshot.browserScope.startsWith("profile:")
        ? snapshot.browserScope.slice("profile:".length)
        : null,
    };
  }
  return {
    profile: null,
    ...(snapshot?.profileId && snapshot.profileId !== DEFAULT_BROWSER_PROFILE_ID
      ? { profileId: snapshot.profileId }
      : {}),
  };
}
