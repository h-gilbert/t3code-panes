import { describe, expect, it, vi } from "vite-plus/test";
import { preserveRendererFocus } from "./PreserveRendererFocus.ts";

function fixture() {
  const listeners = new Map<string, EventListener>();
  const editor = {
    tagName: "DIV",
    isConnected: true,
    focus: vi.fn(() => {
      document.activeElement = editor;
    }),
    getAttribute: (): string | null => null,
  };
  const guest = {
    ...editor,
    tagName: "WEBVIEW",
    getAttribute: () => "tab-1",
  };
  const document = {
    activeElement: editor,
    body: {},
    addEventListener: (name: string, listener: EventListener) => listeners.set(name, listener),
    removeEventListener: (name: string) => listeners.delete(name),
  };
  return { document, editor, guest, listeners, dom: document as unknown as Document };
}

describe("native click renderer focus", () => {
  it("restores the editor immediately when the automated guest takes DOM focus", async () => {
    const f = fixture();
    await preserveRendererFocus(f.dom, "tab-1", async () => {
      f.document.activeElement = f.guest;
      f.listeners.get("focusin")?.(new Event("focusin"));
      expect(f.document.activeElement).toBe(f.editor);
    });
    expect(f.editor.focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(f.listeners.size).toBe(0);
  });

  it("restores focus and removes listeners when the click fails", async () => {
    const f = fixture();
    await expect(
      preserveRendererFocus(f.dom, "tab-1", async () => {
        f.document.activeElement = f.guest;
        throw new Error("navigation interrupted");
      }),
    ).rejects.toThrow("navigation interrupted");
    expect(f.document.activeElement).toBe(f.editor);
    expect(f.listeners.size).toBe(0);
  });

  it("honors intentional human navigation during the action", async () => {
    const f = fixture();
    await preserveRendererFocus(f.dom, "tab-1", async () => {
      f.listeners.get("pointerdown")?.({ isTrusted: true } as Event);
      f.document.activeElement = f.guest;
      f.listeners.get("focusin")?.(new Event("focusin"));
    });
    expect(f.document.activeElement).toBe(f.guest);
    expect(f.editor.focus).not.toHaveBeenCalled();
  });

  it("does not steal focus from another browser tab or a disconnected editor", async () => {
    for (const disconnected of [false, true]) {
      const f = fixture();
      f.editor.isConnected = !disconnected;
      await preserveRendererFocus(f.dom, disconnected ? "tab-1" : "tab-2", async () => {
        f.document.activeElement = f.guest;
      });
      expect(f.editor.focus).not.toHaveBeenCalled();
    }
  });
});
