import { ProviderDriverKind } from "@t3tools/contracts";
import { ClaudeAI, CursorIcon, GrokIcon, Icon, OpenAI, OpenCodeIcon } from "../Icons";
import { PROVIDER_OPTIONS } from "../../session-logic";

export const PROVIDER_ICON_BY_PROVIDER: Partial<Record<ProviderDriverKind, Icon>> = {
  [ProviderDriverKind.make("codex")]: OpenAI,
  [ProviderDriverKind.make("claudeAgent")]: ClaudeAI,
  [ProviderDriverKind.make("opencode")]: OpenCodeIcon,
  [ProviderDriverKind.make("cursor")]: CursorIcon,
  [ProviderDriverKind.make("grok")]: GrokIcon,
};

function isAvailableProviderOption(option: (typeof PROVIDER_OPTIONS)[number]): option is {
  value: ProviderDriverKind;
  label: string;
  available: true;
  pickerSidebarBadge?: "new" | "soon";
} {
  return option.available;
}

export const AVAILABLE_PROVIDER_OPTIONS = PROVIDER_OPTIONS.filter(isAvailableProviderOption);

const PROVIDER_MODEL_NAME_QUALIFIERS: Partial<Record<ProviderDriverKind, readonly string[]>> = {
  [ProviderDriverKind.make("codex")]: ["Codex", "OpenAI"],
  [ProviderDriverKind.make("claudeAgent")]: ["Claude", "Anthropic"],
  [ProviderDriverKind.make("opencode")]: ["OpenCode"],
  [ProviderDriverKind.make("cursor")]: ["Cursor"],
  [ProviderDriverKind.make("grok")]: ["Grok", "xAI"],
};

export type ModelEsque = {
  slug: string;
  name: string;
  shortName?: string | undefined;
  subProvider?: string | undefined;
  isLegacy?: boolean | undefined;
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripLeadingQualifier(value: string, qualifier: string | null | undefined): string {
  const trimmedQualifier = qualifier?.trim();
  if (!trimmedQualifier) {
    return value;
  }

  const pattern = new RegExp(`^${escapeRegExp(trimmedQualifier)}(?:\\s*[.:/-]\\s*|\\s+)`, "iu");
  return value.replace(pattern, "").trim() || value;
}

export function getDisplayModelName(
  model: ModelEsque,
  options?: { preferShortName?: boolean },
): string {
  const name = options?.preferShortName && model.shortName ? model.shortName : model.name;
  return stripLeadingQualifier(name, model.subProvider);
}

export function getProviderIndependentModelName(
  model: ModelEsque,
  driverKind: ProviderDriverKind,
  providerDisplayName: string,
  options?: { preferShortName?: boolean },
): string {
  let name = getDisplayModelName(model, options);
  const qualifiers = [providerDisplayName, ...(PROVIDER_MODEL_NAME_QUALIFIERS[driverKind] ?? [])];
  for (const qualifier of qualifiers) {
    name = stripLeadingQualifier(name, qualifier);
  }
  return name;
}

export function getTriggerDisplayModelName(model: ModelEsque): string {
  return getDisplayModelName(model, { preferShortName: true });
}

export function getTriggerDisplayModelLabel(model: ModelEsque): string {
  return getTriggerDisplayModelName(model);
}
