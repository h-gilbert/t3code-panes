import { useAtomValue } from "@effect/atom-react";
import { useRef, useState } from "react";

import { environmentPresentations } from "../../state/presentation";
import { serverEnvironment } from "../../state/server";
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
import { UsageLimitsPooled } from "./UsageLimitsPooled";
import { useUsageLimitsDialogStore } from "./usageLimitsDialogStore";

export function UsageLimitsDialog({ finalFocus }: { readonly finalFocus: () => boolean }) {
  const open = useUsageLimitsDialogStore((state) => state.open);
  const setOpen = useUsageLimitsDialogStore((state) => state.setOpen);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogPopup className="w-full max-w-3xl" finalFocus={finalFocus}>
        <DialogHeader>
          <DialogTitle>Usage limits</DialogTitle>
          <DialogDescription>
            Subscription allowance remaining across all connected environments.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>{open ? <UsageLimitsDialogBody /> : null}</DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}

function UsageLimitsDialogBody() {
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
