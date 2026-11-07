import { usePrimarySettings, useUpdatePrimarySettings } from "../../hooks/useSettings";
import type { EnvironmentPresentation } from "../../state/environments";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingsRow, SettingsSection } from "./settingsLayout";

export function PreferredThreadEnvironmentSettings({
  environments,
}: {
  environments: ReadonlyArray<EnvironmentPresentation>;
}) {
  const preferred = usePrimarySettings((settings) => settings.preferredThreadEnvironmentId);
  const update = useUpdatePrimarySettings();
  const items = [
    { value: "", label: "No preference" },
    ...environments.map((environment) => ({
      value: environment.environmentId,
      label: environment.label,
    })),
    ...(preferred && !environments.some((environment) => environment.environmentId === preferred)
      ? [{ value: preferred, label: "Unavailable environment" }]
      : []),
  ];
  return (
    <SettingsSection title="New threads">
      <SettingsRow
        title="Preferred environment"
        description="Start new threads here when the project and provider are available. Otherwise use the usual destination. Shared across connected environments; explicit machine choices are preserved."
        control={
          <Select
            items={items}
            value={preferred ?? ""}
            onValueChange={(value) => {
              if (value !== null) update({ preferredThreadEnvironmentId: value || null });
            }}
          >
            <SelectTrigger aria-label="Preferred environment for new threads">
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              {items.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
    </SettingsSection>
  );
}
