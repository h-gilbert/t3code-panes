import { Dialog, DialogPopup } from "../ui/dialog";
import { RightPanelTabs, type RightPanelTabsProps } from "../RightPanelTabs";

type ChatRightPanelProps = Omit<RightPanelTabsProps, "mode" | "inlineSize" | "maximized"> & {
  readonly sheet: boolean;
  readonly maximized: boolean;
  readonly workspaceLayoutElement: HTMLElement | null;
  readonly widthStorageKey: string;
  readonly sheetAnimationDurationMs: number;
  readonly onCloseSheet: () => void;
};

export function ChatRightPanel(props: ChatRightPanelProps) {
  const {
    sheet: _sheet,
    workspaceLayoutElement: _workspaceLayoutElement,
    widthStorageKey: _widthStorageKey,
    sheetAnimationDurationMs: _sheetAnimationDurationMs,
    onCloseSheet,
    maximized: _maximized,
    ...tabs
  } = props;
  return (
    <Dialog
      open={tabs.open === true}
      onOpenChange={(open) => {
        if (!open) onCloseSheet();
      }}
    >
      <DialogPopup
        aria-label="Thread tools"
        showCloseButton={false}
        bottomStickOnMobile={false}
        keepMounted
        className="h-[85dvh] w-[90vw] max-w-6xl overflow-hidden"
      >
        <RightPanelTabs {...tabs} mode="sheet" />
      </DialogPopup>
    </Dialog>
  );
}
