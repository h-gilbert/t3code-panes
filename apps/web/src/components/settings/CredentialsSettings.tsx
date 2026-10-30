import { useProjects } from "~/state/entities";
import { useAtomValue } from "@effect/atom-react";
import { AuthAccessReadScope, type EnvironmentId } from "@t3tools/contracts";
import { useState } from "react";
import { requestConfirmDialog } from "~/confirmDialog";
import { serverEnvironment } from "~/state/server";
import { useEnvironmentScope } from "~/state/session";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";
import { SettingsRow, SettingsSection } from "./settingsLayout";

export function CredentialsSettings({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const projects = useProjects();
  const projectName = (id: string) =>
    projects.find((project) => project.environmentId === environmentId && project.id === id)
      ?.title ?? "Unavailable project";
  const canRead = useEnvironmentScope(environmentId, AuthAccessReadScope);
  const query = useEnvironmentQuery(
    canRead ? serverEnvironment.credentials({ environmentId, input: {} }) : null,
  );
  const remove = useAtomCommand(serverEnvironment.removeCredential, {
    label: "revoke credential",
    reportFailure: false,
    reportDefect: false,
  });
  const canRemove = useAtomValue(serverEnvironment.removeCredential.permissionAtom(environmentId));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const revoke = async (id: string, name: string) => {
    if (
      !(await requestConfirmDialog(
        `Revoke ${name}? Agents will need new credentials next time. Temporary copies already delivered to commands expire within 24 hours.`,
        { variant: "destructive" },
      ))
    )
      return;
    setBusy(true);
    setError(false);
    try {
      const result = await remove({ environmentId, input: { id } });
      if (result._tag === "Success") query.refresh();
      else setError(true);
    } catch {
      setError(true);
    }
    setBusy(false);
  };
  if (!canRead) return null;
  return (
    <SettingsSection
      id="credential-vault"
      title="Credentials"
      headerAction={
        <Button
          size="xs"
          variant="ghost"
          onClick={() => {
            setError(false);
            query.refresh();
          }}
        >
          Refresh
        </Button>
      }
    >
      <SettingsRow
        title="Give credentials privately in a thread"
        description={
          "Ask an agent to save a named login or token. Enter it in the private card and choose which projects may reuse it. To replace one, ask the agent to update it. Credentials are stored on the selected environment and are independent of browser profiles."
        }
      />
      {query.error !== null || error ? (
        <SettingsRow
          title="Could not access credentials"
          description="Try refreshing or reconnecting to this environment."
        />
      ) : null}
      {query.data === null ? (
        <SettingsRow title="Loading credentials…" />
      ) : query.data.credentials.length === 0 ? (
        <SettingsRow title="No saved credentials" />
      ) : (
        query.data.credentials.map((entry) => (
          <SettingsRow
            key={entry.id}
            title={entry.name}
            description={`${entry.kind === "login" ? "Login" : "Secret"}${entry.website ? ` · ${entry.website}` : ""} · ${entry.scope === "environment" ? "All projects on this environment" : `Project: ${projectName(entry.projectId)}`}`}
            control={
              <Button
                size="xs"
                variant="outline"
                disabled={busy || !canRemove}
                onClick={() => void revoke(entry.id, entry.name)}
              >
                Revoke
              </Button>
            }
          />
        ))
      )}
    </SettingsSection>
  );
}
