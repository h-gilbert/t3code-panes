import { useAtomMount, useAtomValue } from "@effect/atom-react";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { AuthPreviewOperateScope, type EnvironmentId, ThreadId } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import { useServerConfigs } from "~/state/entities";
import { primaryEnvironmentIdAtom } from "~/state/primaryEnvironment";
import { useEnvironmentScope } from "~/state/session";
import { previewBridge } from "~/components/preview/previewBridge";
import { previewSessionSyncAtom } from "~/components/preview/usePreviewSession";
import { remoteBrowserHostAtom } from "~/rpc/remoteBrowserHost";
import { previewEnvironment } from "~/state/preview";

/**
 * Follows the preview tabs of every thread in an environment this desktop
 * renders browsers for, its own or one that selected it as browser host, not
 * only threads on screen. Otherwise an agent's tab in a thread nobody has open
 * never gets a webview and its server falls back to a headless browser, which
 * sites such as Google refuse to sign in. A followed thread stays synced while
 * this desktop keeps rendering for the environment.
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
      <HostedPreviewThreads environmentId={primary} />
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
function HostedPreviewThreads({ environmentId }: { environmentId: EnvironmentId }) {
  useAtomMount(hostedPreviewThreadsAtom(environmentId));
  return null;
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
  const atom = remoteBrowserHostAtom({ environmentId, hostEnvironmentId, bridge: previewBridge! });
  useAtomMount(atom);
  return <HostedPreviewThreads environmentId={environmentId} />;
}
