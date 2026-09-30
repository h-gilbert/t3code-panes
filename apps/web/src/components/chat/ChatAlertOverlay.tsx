import { useLayoutEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";

/** Escape pane stacking contexts while keeping alerts anchored to their chat column.
 * Layer 122 clears browser guests at 121 and stays below dialogs at 125.
 */
export function ChatAlertOverlay({ children }: { children: ReactNode }) {
  const anchorRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const updateRef = useRef<(() => void) | null>(null);

  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    const overlay = overlayRef.current;
    if (!anchor || !overlay) return;
    const update = () => {
      const rect = anchor.getBoundingClientRect();
      overlay.style.left = `${rect.left}px`;
      overlay.style.top = `${rect.top}px`;
      overlay.style.width = `${rect.width}px`;
      overlay.style.visibility = rect.width > 0 ? "visible" : "hidden";
    };
    updateRef.current = update;
    update();
    const observer = new ResizeObserver(update);
    observer.observe(anchor);
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
      updateRef.current = null;
    };
  }, []);

  useLayoutEffect(() => {
    updateRef.current?.();
  });

  return (
    <>
      <div ref={anchorRef} className="pointer-events-none absolute inset-x-0 top-0" />
      {createPortal(
        <div
          ref={overlayRef}
          className="pointer-events-none fixed z-[122] flex flex-col"
          style={{ visibility: "hidden" }}
        >
          {children}
        </div>,
        document.body,
      )}
    </>
  );
}
