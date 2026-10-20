import { useAtomMount, useAtomValue } from "@effect/atom-react";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { AuthPreviewOperateScope, type EnvironmentId, ThreadId } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import { useMemo } from "react";
import { useServerConfigs } from "~/state/entities";
import { primaryEnvironmentIdAtom } from "~/state/primaryEnvironment";
import { useEnvironmentScope } from "~/state/session";
import { previewBridge } from "~/components/preview/previewBridge";
import { previewSessionSyncAtom } from "~/components/preview/usePreviewSession";
import { remoteBrowserHostAtom } from "~/rpc/remoteBrowserHost";
import { previewEnvironment } from "~/state/preview";

/**
 * Follows the preview tabs of every thread in an environment this desktop
 * hosts, not only threads on screen, so an agent's new tab gets its webview
 * here while the user looks elsewhere. A followed thread stays synced while
 * this desktop remains the environment's host.
 */
const hostedPreviewThreadsAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get) => {
    const eventsAtom = previewEnvironment.events({ environmentId, input: {} });
    const followed = new Set<string>();
    get.subscribe(eventsAtom, (result) => {
      if (!AsyncResult.isSuccess(result)) return;
      const threadKey = scopedThreadKey(
        scopeThreadRef(environmentId, ThreadId.make(result.value.threadId)),
      );
      if (followed.has(threadKey)) return;
      followed.add(threadKey);
      get.mount(previewSessionSyncAtom(threadKey));
    });
    get.mount(eventsAtom);
  }).pipe(Atom.withLabel(`preview:hosted-threads:${environmentId}`)),
);

export function RemoteBrowserHosts() {
  const primary = useAtomValue(primaryEnvironmentIdAtom);
  const configs = useServerConfigs();
  if (!primary || !previewBridge?.connectRemoteHost) return null;
  return (
    <>
      {[...configs]
        .filter(
          ([id, config]) => id !== primary && config.settings.browserHostEnvironmentId === primary,
        )
        .map(([environmentId]) => (
          <AuthorizedRemoteBrowserHost
            key={environmentId}
            environmentId={environmentId}
            hostEnvironmentId={primary}
          />
        ))}
    </>
  );
}
function AuthorizedRemoteBrowserHost(props: {
  environmentId: EnvironmentId;
  hostEnvironmentId: EnvironmentId;
}) {
  const allowed = useEnvironmentScope(props.environmentId, AuthPreviewOperateScope);
  return allowed ? <RemoteBrowserHost {...props} /> : null;
}
function RemoteBrowserHost({
  environmentId,
  hostEnvironmentId,
}: {
  environmentId: EnvironmentId;
  hostEnvironmentId: EnvironmentId;
}) {
  const atom = useMemo(
    () =>
      remoteBrowserHostAtom({
        environmentId,
        hostEnvironmentId,
        bridge: previewBridge!,
      }),
    [environmentId, hostEnvironmentId],
  );
  useAtomMount(atom);
  useAtomMount(hostedPreviewThreadsAtom(environmentId));
  return null;
}
