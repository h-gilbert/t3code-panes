import { useAtomMount, useAtomValue } from "@effect/atom-react";
import { AuthPreviewOperateScope, type EnvironmentId } from "@t3tools/contracts";
import { useMemo } from "react";
import { useServerConfigs } from "~/state/entities";
import { primaryEnvironmentIdAtom } from "~/state/primaryEnvironment";
import { useEnvironmentScope } from "~/state/session";
import { previewBridge } from "~/components/preview/previewBridge";
import { remoteBrowserHostAtom } from "~/rpc/remoteBrowserHost";

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
  return null;
}
