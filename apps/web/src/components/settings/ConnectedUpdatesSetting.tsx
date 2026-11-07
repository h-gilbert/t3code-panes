import { useEffect, useState } from "react";
import { Switch } from "../ui/switch";
import { SettingsRow } from "./settingsLayout";

export function ConnectedUpdatesSetting({
  bridge = window.desktopBridge,
}: {
  bridge?: Pick<NonNullable<Window["desktopBridge"]>, "connectedUpdates"> | undefined;
}) {
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [allowed, setAllowed] = useState<boolean | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Read the desktop-owned preference through IPC.
  useEffect(() => {
    void bridge
      ?.connectedUpdates?.()
      .then(setAllowed)
      .catch(() => setError("Could not read the desktop update preference."));
  }, [bridge]);
  return (
    <SettingsRow
      title="Allow connected controllers to install updates on this desktop"
      description={
        error ?? "Connected controllers with full access can update this desktop when it is idle."
      }
      control={
        <Switch
          checked={allowed === true}
          disabled={allowed === null || saving}
          onCheckedChange={(enabled) => {
            setSaving(true);
            setError(null);
            void bridge
              ?.connectedUpdates?.(enabled)
              .then(setAllowed)
              .catch(() => setError("Could not save the desktop update preference."))
              .finally(() => setSaving(false));
          }}
        />
      }
    />
  );
}
