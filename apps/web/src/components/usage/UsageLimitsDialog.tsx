import { useAtomValue } from "@effect/atom-react";
import { isModelCostUnknown } from "@t3tools/shared/usageMerge";
import { formatPercent, formatTokens, formatUsd, makeWindow } from "@t3tools/shared/usageFormat";
import { useRef, useState } from "react";

import { environmentPresentations } from "../../state/presentation";
import { serverEnvironment } from "../../state/server";
import { useUsage } from "../../state/usage";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { RefreshIcon } from "../ui/refresh-icon";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { UsageLimitsPooled } from "./UsageLimitsPooled";
import { PROVIDER_ORDER, PROVIDER_PRESENTATION } from "./usageProviders";
import { useUsageLimitsDialogStore } from "./usageLimitsDialogStore";

export function UsageLimitsDialog({ finalFocus }: { readonly finalFocus: () => boolean }) {
  const open = useUsageLimitsDialogStore((state) => state.open);
  const setOpen = useUsageLimitsDialogStore((state) => state.setOpen);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogPopup
        className="h-[calc(100dvh-3rem)] w-full max-w-6xl sm:h-[min(calc(100dvh-2rem),64rem)]"
        finalFocus={finalFocus}
      >
        <DialogHeader>
          <DialogTitle>Usage</DialogTitle>
          <DialogDescription>
            Subscription limits and recorded model usage across connected environments.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>{open ? <UsageLimitsDialogBody /> : null}</DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}

function UsageLimitsDialogBody() {
  const [view, setView] = useState<"limits" | "models">("limits");
  return (
    <div className="flex flex-col gap-4">
      <ToggleGroup
        aria-label="Usage view"
        variant="segmented"
        value={[view]}
        onValueChange={(next) => {
          if (next[0] === "limits" || next[0] === "models") setView(next[0]);
        }}
      >
        <Toggle value="limits">Limits</Toggle>
        <Toggle value="models">Model usage</Toggle>
      </ToggleGroup>
      {view === "limits" ? <UsageLimitsView /> : <UsageModelsView />}
    </div>
  );
}

function UsageLimitsView() {
  const presentations = useAtomValue(environmentPresentations.presentationsAtom);
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders);
  const [now, setNow] = useState(() => Date.now());
  const [refreshing, setRefreshing] = useState(false);
  const refreshingRef = useRef(false);
  const connected = [...presentations].filter(
    ([, presentation]) =>
      presentation.connection.phase === "connected" && presentation.serverConfig !== null,
  );

  const refresh = async () => {
    if (refreshingRef.current) return;
    refreshingRef.current = true;
    setRefreshing(true);
    try {
      await Promise.all(
        connected.map(([environmentId]) => refreshProviders({ environmentId, input: {} })),
      );
    } finally {
      setNow(Date.now());
      refreshingRef.current = false;
      setRefreshing(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex justify-end">
        <Button
          variant="ghost"
          size="sm"
          disabled={refreshing || connected.length === 0}
          aria-busy={refreshing}
          onClick={() => void refresh()}
        >
          <RefreshIcon className="size-3.5" refreshing={refreshing} />
          Refresh limits
        </Button>
      </div>
      <UsageLimitsPooled presentations={presentations} now={now} compact />
    </div>
  );
}

const USAGE_WINDOWS = [
  { days: 1, label: "24h" },
  { days: 7, label: "7 days" },
  { days: 30, label: "30 days" },
  { days: 90, label: "90 days" },
] as const;

function UsageModelsView() {
  const [selection, setSelection] = useState(() => ({
    days: 7,
    window: makeWindow(7, undefined, "day"),
  }));
  const { days, window } = selection;
  const { merged, environments, isPending, isPartial, refresh } = useUsage(window);
  const [refreshing, setRefreshing] = useState(false);
  const models = merged.models.toSorted(
    (left, right) => right.totalTokens - left.totalTokens || right.costUsd - left.costUsd,
  );
  const activeProviders = PROVIDER_ORDER.filter((provider) =>
    models.some((model) => model.provider === provider),
  );
  const errors = environments.filter((environment) => environment.error !== null);

  const refreshModels = async () => {
    setRefreshing(true);
    try {
      const nextWindow = makeWindow(days, undefined, days === 1 ? "hour" : "day");
      setSelection({ days, window: nextWindow });
      await refresh(nextWindow);
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <ToggleGroup
          aria-label="Usage period"
          variant="segmented"
          value={[String(days)]}
          onValueChange={(next) => {
            const selected = USAGE_WINDOWS.find((option) => String(option.days) === next[0]);
            if (selected)
              setSelection({
                days: selected.days,
                window: makeWindow(selected.days, undefined, selected.days === 1 ? "hour" : "day"),
              });
          }}
        >
          {USAGE_WINDOWS.map((option) => (
            <Toggle key={option.days} value={String(option.days)}>
              {option.label}
            </Toggle>
          ))}
        </ToggleGroup>
        <Button
          variant="ghost"
          size="sm"
          disabled={refreshing || environments.length === 0}
          aria-busy={refreshing}
          onClick={() => void refreshModels()}
        >
          <RefreshIcon className="size-3.5" refreshing={refreshing} />
          Refresh usage
        </Button>
      </div>
      <div className="flex items-baseline justify-between gap-3 border-b border-border pb-3">
        <span className="text-sm text-muted-foreground">Processed tokens</span>
        <span className="text-lg font-semibold tabular-nums">
          {formatTokens(merged.totalTokens)}
        </span>
      </div>
      {isPending ? <p className="text-sm text-muted-foreground">Loading usage…</p> : null}
      {isPartial ? (
        <p className="text-sm text-muted-foreground">Some environments are still reporting.</p>
      ) : null}
      {errors.length > 0 ? (
        <p className="text-sm text-muted-foreground">
          Usage is unavailable from {errors.map((environment) => environment.label).join(", ")}.
        </p>
      ) : null}
      {!isPending && models.length === 0 ? (
        <p className="py-4 text-center text-sm text-muted-foreground">
          No recorded model usage in this period.
        </p>
      ) : null}
      {models.length > 0 ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <p className="text-xs text-muted-foreground sm:col-span-2">
            Bars show each model's share of recorded tokens within its provider, including CLI work
            outside T3 Code. Subscription limits do not report how much each model used.
          </p>
          {activeProviders.map((provider) => {
            const providerModels = models.filter((model) => model.provider === provider);
            const providerTokens = providerModels.reduce(
              (total, model) => total + model.totalTokens,
              0,
            );
            return (
              <section
                key={provider}
                className="flex flex-col gap-3 rounded-lg border border-border p-4"
              >
                <div className="flex items-baseline justify-between gap-3">
                  <h2 className="text-sm font-medium">{PROVIDER_PRESENTATION[provider].label}</h2>
                  <span className="text-xs tabular-nums text-muted-foreground">
                    {formatTokens(providerTokens)} tokens
                  </span>
                </div>
                {providerModels.map((model) => {
                  const share = providerTokens === 0 ? 0 : model.totalTokens / providerTokens;
                  return (
                    <div key={model.model} className="flex flex-col gap-1">
                      <div className="flex items-baseline justify-between gap-3 text-sm">
                        <span className="min-w-0 break-all">{model.model}</span>
                        <span className="shrink-0 tabular-nums">{formatPercent(share)}</span>
                      </div>
                      <div className="h-2 overflow-hidden rounded-full bg-muted" aria-hidden="true">
                        <div
                          className="h-full rounded-full"
                          style={{
                            width: `${Math.min(100, Math.max(0, share * 100))}%`,
                            backgroundColor: PROVIDER_PRESENTATION[provider].color,
                          }}
                        />
                      </div>
                      <div className="flex justify-between gap-3 text-xs tabular-nums text-muted-foreground">
                        <span>{formatTokens(model.totalTokens)} tokens</span>
                        <span>
                          {isModelCostUnknown(model)
                            ? "Unpriced"
                            : `${formatUsd(model.costUsd)} est.`}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </section>
            );
          })}
        </div>
      ) : null}
      <p className="text-xs text-muted-foreground">
        Cost is an API-equivalent estimate, not your subscription bill. For environment filters and
        daily trends, open Usage in the sidebar.
      </p>
    </div>
  );
}
