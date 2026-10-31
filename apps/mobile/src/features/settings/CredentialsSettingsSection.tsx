import { useProjects } from "../../state/entities";
import { useAtomValue } from "@effect/atom-react";
import { AuthAccessReadScope, type EnvironmentId } from "@t3tools/contracts";
import { useState } from "react";
import { AppText as Text } from "../../components/ui/AppText";
import * as Dialog from "../../components/ui/Dialog";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentQuery } from "../../state/query";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsSection } from "./components/SettingsSection";

export function CredentialsSettingsSection({
  environmentId,
}: {
  readonly environmentId: EnvironmentId;
}) {
  const projects = useProjects();
  const projectName = (id: string, repositoryKey?: string) =>
    projects.find((project) => project.environmentId === environmentId && project.id === id)
      ?.title ??
    repositoryKey ??
    "Unavailable project";
  const canRead = useEnvironmentScope(environmentId, AuthAccessReadScope);
  const entries = useEnvironmentQuery(
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
  const revoke = (id: string, name: string) =>
    Dialog.confirm({
      title: `Revoke ${name}?`,
      message:
        "Agents will need new credentials next time. Temporary copies already delivered expire within 24 hours.",
      confirmText: "Revoke",
      destructive: true,
      onConfirm: () => {
        void (async () => {
          setBusy(true);
          setError(false);
          try {
            const result = await remove({ environmentId, input: { id } });
            if (result._tag === "Success") entries.refresh();
            else setError(true);
          } catch {
            setError(true);
          }
          setBusy(false);
        })();
      },
    });
  if (!canRead) return null;
  return (
    <SettingsSection
      title="Credentials"
      footer="Ask an agent in a thread to save or replace a named login or token using a private card. Credentials stay on this environment."
    >
      <ListActionRow label="Refresh credentials" icon="arrow.clockwise" onPress={entries.refresh} />
      {error || entries.error ? (
        <Text className="p-4 text-sm text-danger-foreground">
          Could not access credentials. Try refreshing.
        </Text>
      ) : null}
      {entries.data?.credentials.length === 0 ? (
        <Text className="p-4 text-sm text-foreground-muted">No saved credentials</Text>
      ) : (
        entries.data?.credentials.map((entry) => (
          <ListActionRow
            key={entry.id}
            label={entry.name}
            description={`${entry.scope === "environment" ? "All projects" : `Project: ${projectName(entry.projectId, entry.repositoryKey)}`} · Tap to revoke`}
            icon={{ ios: "lock", android: "lock" }}
            tone="danger"
            disabled={busy || !canRemove}
            onPress={() => revoke(entry.id, entry.name)}
          />
        ))
      )}
    </SettingsSection>
  );
}
