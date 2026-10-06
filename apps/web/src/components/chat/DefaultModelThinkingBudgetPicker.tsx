import type { ModelSelection, ServerProviderModel } from "@t3tools/contracts";
import { getProviderOptionCurrentValue, getProviderOptionDescriptors } from "@t3tools/shared/model";
import {
  Menu,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuItem,
  MenuSeparator,
} from "../ui/menu";

const THINKING_OPTION_IDS = new Set(["reasoningEffort", "effort", "variant", "thinking"]);

export function getDefaultModelThinkingBudgetDescriptors(
  model: ServerProviderModel | undefined,
  selection: ModelSelection,
) {
  if (!model?.capabilities) return [];
  return getProviderOptionDescriptors({
    caps: model.capabilities,
    selections: selection.options,
  })
    .map((descriptor) => {
      if (descriptor.type === "boolean") return descriptor;
      // Prompt prefixes cannot be stored as a default model option.
      return {
        ...descriptor,
        options: descriptor.options.filter(
          (option) => !descriptor.promptInjectedValues?.includes(option.id),
        ),
      };
    })
    .filter(
      (descriptor) =>
        THINKING_OPTION_IDS.has(descriptor.id) &&
        (descriptor.type === "boolean" || descriptor.options.length > 0),
    );
}

export function DefaultModelThinkingBudgetPicker(props: {
  model: ServerProviderModel | undefined;
  selection: ModelSelection;
  anchor: HTMLElement | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChange: (selection: ModelSelection) => void;
  onClear?: () => void;
}) {
  const descriptors = getDefaultModelThinkingBudgetDescriptors(props.model, props.selection);
  return (
    <Menu open={props.open} onOpenChange={props.onOpenChange}>
      <MenuPopup anchor={props.anchor} align="start" side="right" data-model-picker-content="true">
        <div className="px-2 py-1.5 text-xs text-muted-foreground">
          Default · {props.model?.shortName ?? props.model?.name ?? props.selection.model}
        </div>
        {descriptors.map((descriptor) => {
          const value = getProviderOptionCurrentValue(descriptor);
          const options =
            descriptor.type === "select"
              ? descriptor.options
              : [
                  { id: "true", label: "On" },
                  { id: "false", label: "Off" },
                ];
          return (
            <div key={descriptor.id}>
              <div className="px-2 py-1 text-xs text-muted-foreground">{descriptor.label}</div>
              <MenuRadioGroup
                value={value === undefined ? "" : String(value)}
                onValueChange={(nextValue) => {
                  props.onChange({
                    ...props.selection,
                    options: [
                      ...(props.selection.options ?? []).filter(
                        (option) => option.id !== descriptor.id,
                      ),
                      {
                        id: descriptor.id,
                        value: descriptor.type === "boolean" ? nextValue === "true" : nextValue,
                      },
                    ],
                  });
                }}
              >
                {options.map((option) => (
                  <MenuRadioItem key={option.id} value={option.id} closeOnClick>
                    {option.label}
                  </MenuRadioItem>
                ))}
              </MenuRadioGroup>
            </div>
          );
        })}
        {props.onClear ? (
          <>
            <MenuSeparator />
            <MenuItem onClick={props.onClear}>Clear default model</MenuItem>
          </>
        ) : null}
      </MenuPopup>
    </Menu>
  );
}
