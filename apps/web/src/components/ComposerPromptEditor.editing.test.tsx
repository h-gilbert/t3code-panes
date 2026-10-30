// @vitest-environment jsdom

import { act, createRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";

import {
  ComposerPromptEditorTiptap as ComposerPromptEditor,
  type ComposerPromptEditorHandle,
} from "./ComposerPromptEditorTiptap";

afterEach(() => vi.unstubAllGlobals());

it("keeps pasted text, line-break edits, and clearing in sync with the placeholder", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ClipboardEvent", Event);
  Range.prototype.getBoundingClientRect = () => new DOMRect();
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const editorRef = createRef<ComposerPromptEditorHandle>();
  const pastedText = "Happy to talk these through if that's easier.\n\nThanks,\nHamish";
  function Harness() {
    const [prompt, setPrompt] = useState("");
    const [cursor, setCursor] = useState(0);
    return (
      <>
        <button onClick={() => setPrompt("")}>Clear</button>
        <output>{prompt}</output>
        <ComposerPromptEditor
          value={prompt}
          cursor={cursor}
          contextRecords={new Map()}
          skills={[]}
          disabled={false}
          placeholder="Write a message"
          onChange={(text, nextCursor) => {
            setPrompt(text);
            setCursor(nextCursor);
          }}
          onPaste={() => editorRef.current?.readSelectionRange()}
          onCommandKeyDown={() => {
            // ChatComposer reads the current prompt to resolve suggestions on Enter.
            editorRef.current?.readSnapshot();
            return false;
          }}
          editorRef={editorRef}
        />
      </>
    );
  }
  try {
    await act(async () => root.render(<Harness />));
    const editable = container.querySelector<HTMLElement>('[contenteditable="true"]')!;
    await act(async () => editorRef.current!.focusAt(0));
    const paste = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(paste, "clipboardData", {
      value: { files: [], types: ["text/plain"], getData: () => pastedText },
    });
    await act(async () => editable.dispatchEvent(paste));
    expect(container.querySelector("output")!.textContent).toBe(pastedText);
    expect(container.textContent).not.toContain("Write a message");
    await act(async () => {
      editable.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          code: "Enter",
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    expect(container.querySelector("output")!.textContent).toBe(`${pastedText}\n`);
    await act(async () => editorRef.current!.startTypingAtEnd("!"));
    expect(container.querySelector("output")!.textContent).toBe(`${pastedText}\n!`);
    await act(async () => container.querySelector("button")!.click());
    expect(editable.textContent).toBe("");
    expect(editorRef.current!.readSnapshot().value).toBe("");
    expect(container.textContent).toContain("Write a message");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
