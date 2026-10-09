// @vitest-environment jsdom

import { act, createRef, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, MessageId, ThreadId, type AssistantCitation } from "@t3tools/contracts";
import { serializeAssistantCitation } from "@t3tools/shared/assistantCitations";

import { ComposerPromptEditor, type ComposerPromptEditorHandle } from "./ComposerPromptEditor";

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
}));

afterEach(() => vi.unstubAllGlobals());

it.each(["none", "editor", "react"])(
  "opens the citation comment editor when the prompt clear is pending in %s",
  async (pendingClear) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const source = document.createElement("div");
    source.textContent = "Selected assistant text";
    document.body.append(source);
    const range = document.createRange();
    range.selectNodeContents(source);
    range.getBoundingClientRect = () => new DOMRect(20, 20, 100, 20);
    const rect = new DOMRect(20, 20, 100, 20);
    range.getClientRects = () => ({
      0: rect,
      length: 1,
      item: () => rect,
      [Symbol.iterator]: () => [rect][Symbol.iterator](),
    });
    const editorRef = createRef<ComposerPromptEditorHandle>();
    const citation: AssistantCitation = {
      version: 1,
      environmentId: EnvironmentId.make("env"),
      threadId: ThreadId.make("thread"),
      messageId: MessageId.make("message"),
      text: "Selected assistant text",
      start: 0,
      end: 23,
      prefix: "",
      suffix: "",
    };
    const previousValue = "";
    const value = `${serializeAssistantCitation(citation)} `;
    function Harness() {
      const [prompt, setPrompt] = useState(
        pendingClear === "none" ? previousValue : "The previous prompt",
      );
      const [cursor, setCursor] = useState(0);
      const insert = () => {
        if (pendingClear === "editor") flushSync(() => setPrompt(""));
        editorRef.current!.requestCitationComment({
          previousValue: pendingClear === "react" ? "The previous prompt" : previousValue,
          value,
          citationStart: 0,
          sourceAnchor: {
            source,
            viewport: document.body,
            range,
          },
        });
        setPrompt(value);
        setCursor(1);
      };
      return (
        <>
          <button type="button" onClick={insert}>
            Cite
          </button>
          <ComposerPromptEditor
            value={prompt}
            cursor={cursor}
            contextRecords={new Map()}
            skills={[]}
            disabled={false}
            placeholder="Message"
            onChange={(text, nextCursor) => {
              setPrompt(text);
              setCursor(nextCursor);
            }}
            onPaste={() => {}}
            editorRef={editorRef}
          />
        </>
      );
    }
    try {
      await act(async () => root.render(<Harness />));
      await act(async () => container.querySelector("button")!.click());
      expect(editorRef.current!.readSnapshot().value).toBe(value);
      expect(
        document.querySelector('textarea[aria-label="Comment on selected text"]'),
      ).not.toBeNull();
    } finally {
      await act(async () => root.unmount());
      container.remove();
      source.remove();
    }
  },
);

it("reads the cleared draft rather than the previous prompt while the editor update is pending", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const editorRef = createRef<ComposerPromptEditorHandle>();
  function Harness() {
    const [prompt, setPrompt] = useState("The previous prompt");
    return (
      <>
        <button type="button" onClick={() => setPrompt("")}>
          Clear prompt
        </button>
        <ComposerPromptEditor
          value={prompt}
          cursor={0}
          contextRecords={new Map()}
          skills={[]}
          disabled={false}
          placeholder="Message"
          onChange={setPrompt}
          onPaste={() => {}}
          editorRef={editorRef}
        />
      </>
    );
  }
  try {
    await act(async () => root.render(<Harness />));
    await act(async () => {
      flushSync(() => container.querySelector("button")!.click());
      expect(editorRef.current!.readSnapshot().value).toBe("");
    });
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
