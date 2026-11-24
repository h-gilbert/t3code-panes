import { EnvironmentId, type AuthEnvironmentScope } from "@t3tools/contracts";
import { useThreadFindHighlights } from "./chat/threadFindHighlights";
import { searchableMessageSegments } from "@t3tools/shared/threadFindText";
import { countThreadSearchOccurrences } from "@t3tools/shared/threadSearch";

import { MarkdownFindContext } from "./chat/markdownFindContext";
import { useState } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import { getSyntaxHighlighterPromise } from "../lib/syntaxHighlighting";
import { setMarkdownTaskChecked } from "@t3tools/shared/markdownTaskEdits";

import { act, fakeTimers, render } from "../../test/render";

// Isolate switching between a rendered diagram and its searchable source.
vi.mock(import("./chat/MermaidDiagram"), () => ({
  MermaidDiagram: () => <svg aria-label="Diagram" />,
}));

vi.mock(import("../state/session"), async (original) => {
  const { AuthStandardClientScopes } = await import("@t3tools/contracts");
  const grantedScopes = new Set<AuthEnvironmentScope>(AuthStandardClientScopes);
  const hasScope = (environmentId: EnvironmentId | null, scope: AuthEnvironmentScope) =>
    environmentId !== null && grantedScopes.has(scope);
  return {
    ...(await original()),
    useEnvironmentScope: hasScope,
    readEnvironmentScope: hasScope,
  };
});
vi.mock(import("../remoteOpen"), async (original) => ({
  ...(await original()),
  useRemoteOpenResolution: () => ({ state: { mode: "local-exec" }, isResolved: true }) as const,
}));

import ChatMarkdown from "./ChatMarkdown";

function spyOnStreamChunks(highlighter: Awaited<ReturnType<typeof getSyntaxHighlighterPromise>>) {
  const enqueue = vi.fn<(chunk: string) => void>();
  const createStreamTokenizer = highlighter.createStreamTokenizer.bind(highlighter);
  const spies = new DisposableStack();
  spies.use(
    vi.spyOn(highlighter, "createStreamTokenizer").mockImplementation((...args) => {
      const tokenizer = createStreamTokenizer(...args);
      const originalEnqueue = tokenizer.enqueue.bind(tokenizer);
      spies.use(
        vi.spyOn(tokenizer, "enqueue").mockImplementation((chunk) => {
          enqueue(chunk);
          return originalEnqueue(chunk);
        }),
      );
      return tokenizer;
    }),
  );
  return { enqueue, [Symbol.dispose]: () => spies.dispose() };
}

describe("ChatMarkdown bare anchor placeholders", () => {
  it.each(["<A>", "<a>", "<a >", "<a/>", "<A/>", "<a />"])(
    "preserves unmatched %s without linking later blocks",
    async (token) => {
      const text = `- **"From ${token}"** appears in the header.\n\n- **Tests:** cover inheritance.\n\nThe deferred move continues on B.\n\nSee <a href="https://example.com">the link</a>.`;
      await using screen = await render(<ChatMarkdown cwd="/tmp/project" text={text} />);

      expect(screen.container.querySelector("strong")?.textContent).toBe(`"From ${token}"`);
      expect([...screen.container.querySelectorAll("a")].map((link) => link.textContent)).toEqual([
        "the link",
      ]);
      expect(screen.container.querySelectorAll("li")).toHaveLength(2);
      expect(
        [...screen.container.querySelectorAll("p")].map((paragraph) => paragraph.textContent),
      ).toContain("The deferred move continues on B.");
    },
  );

  it.each(["</a>  ", "<div>more</div>\n</a>"])(
    "preserves a paired anchor closing in the raw block %s",
    async (closing) => {
      await using screen = await render(
        <ChatMarkdown cwd="/tmp/project" text={`See <a>label\n\n${closing}\n\nfinish`} />,
      );
      expect(screen.container.querySelector("p")?.textContent).toBe("See label");
    },
  );

  it.each(["<!-- </a> -->", '<div title="</a>">more</div>'])(
    "ignores apparent closing anchors inside %s",
    async (html) => {
      await using screen = await render(
        <ChatMarkdown cwd="/tmp/project" text={`Before <A>.\n\n${html}\n\nAfter.`} />,
      );
      expect(screen.container.querySelector("p")?.textContent).toBe("Before <A>.");
      expect(screen.container.querySelectorAll("a")).toHaveLength(0);
    },
  );

  it("preserves paired HTML anchors, details, markdown links, and inline code", async () => {
    const text =
      'Bare <a>label</a>, <a id="section"></a>, `<A>`, and [docs](https://example.com).\n\n<details><summary>More</summary>Details</details>';
    await using screen = await render(<ChatMarkdown cwd="/tmp/project" text={text} />);

    expect([...screen.container.querySelectorAll("a")].map((link) => link.textContent)).toEqual([
      "label",
      "",
      "docs",
    ]);
    expect(screen.container.querySelector("code")?.textContent).toBe("<A>");
    expect(screen.container.querySelector("[data-markdown-details]")?.textContent).toContain(
      "More",
    );
  });
});

describe("ChatMarkdown context references", () => {
  it("renders text and image references through the chip renderer, with readable fallback", async () => {
    const text =
      "See [Terminal output](t3-context://v1/terminal/term-1) and ![Error image](t3-context://v1/image/img-1).";
    await using screen = await render(
      <ChatMarkdown
        cwd={undefined}
        text={text}
        renderContextReference={({ kind, label }) => (
          <button>
            {kind}: {label}
          </button>
        )}
      />,
    );
    await expect
      .element(screen.getByRole("button", { name: "terminal: Terminal output" }))
      .toBeVisible();
    await expect.element(screen.getByRole("button", { name: "image: Error image" })).toBeVisible();
    expect(screen.container.querySelectorAll("img, a")).toHaveLength(0);

    await screen.rerender(<ChatMarkdown cwd={undefined} text={text} />);
    expect([...screen.container.querySelectorAll("span")].map((span) => span.textContent)).toEqual([
      "Terminal output",
      "Error image",
    ]);
    expect(screen.container.querySelectorAll("img")).toHaveLength(0);
  });

  it("reads formatted context labels through nested markup instead of the context id", async () => {
    await using screen = await render(
      <ChatMarkdown
        cwd={undefined}
        text="See [**Bold** `code`](t3-context://v1/terminal/term-1)."
        renderContextReference={({ kind, label }) => (
          <button>
            {kind}: {label}
          </button>
        )}
      />,
    );
    await expect.element(screen.getByRole("button", { name: "terminal: Bold code" })).toBeVisible();
  });
});

describe("ChatMarkdown favicon privacy", () => {
  it("suppresses private link images while preserving public links across updates", async () => {
    const markdown = (url: string) => <ChatMarkdown cwd="/tmp/project" text={`[Link](${url})`} />;
    // Keep the lazy favicon outside Chromium's loading distance.
    const container = document.createElement("div");
    container.style.marginTop = "100000px";
    await using screen = await render(markdown("https://example.com"), { container });
    const imageSources = () => [...container.querySelectorAll("img")].map((image) => image.src);
    expect(imageSources()).toEqual(["https://www.google.com/s2/favicons?domain=example.com&sz=32"]);
    for (const url of ["http://192.168.1.10:8080", "http://localhost:3000", "http://home.arpa"]) {
      await screen.rerender(markdown(url));
      expect(imageSources()).toHaveLength(0);
      expect(container.querySelector("a")?.getAttribute("href")).toBe(url);
    }
    await screen.rerender(markdown("https://example.com"));
    expect(imageSources()).toHaveLength(1);

    await screen.rerender(markdown("https://github.com/pingdotgg/t3code/pull/1"));
    expect(imageSources()).toHaveLength(0);
    expect(container.querySelectorAll('a svg path[fill="currentColor"]')).toHaveLength(1);
  });
});

describe("ChatMarkdown streaming", () => {
  it("runs only a complete single-line shell block after a click", async () => {
    const onRunShellCommand = vi.fn();
    const message = (text: string, isStreaming = false) => (
      <ChatMarkdown
        cwd="/tmp/project"
        text={text}
        isStreaming={isStreaming}
        onRunShellCommand={onRunShellCommand}
      />
    );
    await Promise.all([
      getSyntaxHighlighterPromise("bash"),
      getSyntaxHighlighterPromise("typescript"),
    ]);
    await using screen = await render(message("```bash\necho hello\n```", true));
    const run = screen.getByRole("button", { name: "Run in terminal" });
    await expect.element(run).not.toBeInTheDocument();

    await screen.rerender(message("```bash\necho hello\n```"));
    await run.click();
    expect(onRunShellCommand).toHaveBeenCalledExactlyOnceWith("echo hello");

    for (const text of [
      "~~~bash\necho tilde\n~~~",
      "> ```bash\n> echo quote\n> ```",
      "````bash\necho four\n````",
    ]) {
      await screen.rerender(message(text));
      await expect.element(run).toBeVisible();
    }

    for (const text of [
      "```bash\necho one\necho two\n```",
      "```typescript\necho hello\n```",
      "```bash\n\n```",
      "```bash\necho hello\n\n```",
      "```bash\necho hello\\\n```",
      "```bash\necho safe \u202e#\n```",
      "```bash\necho incomplete",
      "~~~bash\necho incomplete",
      "````bash\necho incomplete\n```",
      '<pre><code class="language-bash">echo html</code></pre>',
    ]) {
      await screen.rerender(message(text));
      await expect.element(run).not.toBeInTheDocument();
    }
  });

  it("does not retokenize completed lines when streaming finishes", async () => {
    const highlighter = await getSyntaxHighlighterPromise("typescript");
    using chunks = spyOnStreamChunks(highlighter);
    const text = "```typescript\nconst completed = 1;\nconst current = 2;";
    await using screen = await render(<ChatMarkdown cwd="/tmp/project" text={text} isStreaming />);
    expect(chunks.enqueue).toHaveBeenCalledWith(expect.stringContaining("const completed"));
    chunks.enqueue.mockClear();

    await screen.rerender(<ChatMarkdown cwd="/tmp/project" text={text + "\n```"} />);
    expect(chunks.enqueue).not.toHaveBeenCalled();
    await expect.element(screen.getByRole("button", { name: "Copy code" })).toBeVisible();
  });

  it("recovers highlighting after a failed fence changes without resetting its controls", async () => {
    const highlighter = await getSyntaxHighlighterPromise("text");
    const codeToTokens = highlighter.codeToTokens.bind(highlighter);
    let fail = true;
    using _tokens = vi.spyOn(highlighter, "codeToTokens").mockImplementation((...args) => {
      if (fail) throw new Error("Temporary highlighter failure");
      return codeToTokens(...args);
    });
    using _error = vi.spyOn(console, "error").mockImplementation(() => {});
    using _warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await using screen = await render(
      <ChatMarkdown cwd="/tmp/project" text={"```text\ninitial\n```"} isStreaming />,
    );
    const block = () => screen.container.querySelector('[data-language="text"]');
    const codeBlock = block();
    const initialWrap = codeBlock?.getAttribute("data-wrap") === "true";
    await screen
      .getByRole("button", { name: initialWrap ? "Disable line wrap" : "Wrap lines" })
      .click();
    expect(screen.container.querySelectorAll(".chat-markdown-shiki")).toHaveLength(0);

    fail = false;
    await screen.rerender(
      <ChatMarkdown cwd="/tmp/project" text={"```text\nrecovered\n```"} isStreaming />,
    );
    expect(screen.container.querySelectorAll(".chat-markdown-shiki")).toHaveLength(1);
    expect(block()).toBe(codeBlock);
    expect(codeBlock?.getAttribute("data-wrap")).toBe(String(!initialWrap));
  });

  it("preserves code controls and details without highlighting an unchanged fence again", async () => {
    const highlighter = await getSyntaxHighlighterPromise("text");
    using chunks = spyOnStreamChunks(highlighter);
    const text = [
      "```text",
      "First code block",
      "```",
      "",
      "<details><summary>More</summary>",
      "",
      "Details content",
      "",
      "</details>",
      "",
      "Streaming reply",
    ].join("\n");

    await using screen = await render(<ChatMarkdown cwd="/tmp/project" text={text} isStreaming />);
    using write = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
    using _timers = fakeTimers();
    const block = () => screen.container.querySelector('[data-language="text"]');
    const detailsElement = () => screen.container.querySelector("[data-markdown-details]");
    const codeBlock = block();
    const initialWrap = codeBlock?.getAttribute("data-wrap") === "true";
    await screen
      .getByRole("button", { name: initialWrap ? "Disable line wrap" : "Wrap lines" })
      .click();
    await screen.getByRole("button", { name: "Copy code" }).click();
    await screen.getByRole("button", { name: "More" }).click();

    const details = detailsElement();
    expect(details?.getAttribute("data-markdown-details-open")).toBe("true");
    expect(write).toHaveBeenCalledWith("First code block");
    expect(chunks.enqueue).toHaveBeenCalledTimes(1);

    for (let index = 0; index < 10; index += 1) {
      await screen.rerender(
        <ChatMarkdown cwd="/tmp/project" text={`${text} ${index}`} isStreaming />,
      );
    }

    expect(chunks.enqueue).toHaveBeenCalledTimes(1);
    expect(block()).toBe(codeBlock);
    expect(codeBlock?.getAttribute("data-wrap")).toBe(String(!initialWrap));
    expect(detailsElement()).toBe(details);
    expect(details?.getAttribute("data-markdown-details-open")).toBe("true");
    await screen.rerender(
      <ChatMarkdown
        cwd="/tmp/project"
        text={text.replace("First code block", "Updated code block")}
        isStreaming
      />,
    );
    await screen.getByRole("button", { name: "Copied" }).click();
    expect(write).toHaveBeenLastCalledWith("Updated code block");
    expect(chunks.enqueue).toHaveBeenCalledTimes(2);
  });

  it("edits the current task text and marker after reusing a renderer", async () => {
    const longerText = "- [ ] A longer first task\n- [ ] Second";
    const onEdit = vi.fn();
    function TaskList({ initialText }: { initialText: string }) {
      const [checkedText, setCheckedText] = useState<string>();
      const text = checkedText ?? initialText;
      return (
        <ChatMarkdown
          cwd="/tmp/project"
          text={text}
          onTaskListChange={({ markerOffset, checked }) => {
            const edited = setMarkdownTaskChecked(text, markerOffset, checked);
            onEdit(edited);
            setCheckedText(edited);
          }}
        />
      );
    }

    await using screen = await render(<TaskList initialText={"- [ ] First\n- [ ] Second"} />);
    const input = screen.getByRole("checkbox").nth(1);
    const originalInput = input.element();
    await screen.rerender(<TaskList initialText={longerText} />);
    expect(input.element()).toBe(originalInput);

    await input.click();
    expect(onEdit).toHaveBeenCalledExactlyOnceWith("- [ ] A longer first task\n- [x] Second");
    await expect.element(input).toBeChecked();
  });
});

describe("ChatMarkdown skill chips", () => {
  it("updates digit-leading skill labels when discovered skills change", async () => {
    const text = "Use $2spec with a $20k budget.";
    await using screen = await render(<ChatMarkdown cwd="/tmp/project" text={text} />);
    const skill = screen.getByText("2Spec", { exact: true });
    await expect.element(skill).not.toBeInTheDocument();

    await screen.rerender(
      <ChatMarkdown
        cwd="/tmp/project"
        text={text}
        skills={[
          { name: "2spec", displayName: "2Spec", path: "/skills/2spec", enabled: true },
          { name: "20k", displayName: "MoneySkill", path: "/skills/20k", enabled: true },
        ]}
      />,
    );
    await expect.element(skill).toBeVisible();
    await expect.element(screen.getByText("MoneySkill", { exact: true })).not.toBeInTheDocument();

    await screen.rerender(<ChatMarkdown cwd="/tmp/project" text={text} skills={[]} />);
    await expect.element(skill).not.toBeInTheDocument();
  });
});

describe("ChatMarkdown file option chips", () => {
  it("keeps the fallback button text selectable", async () => {
    await using screen = await render(
      <ChatMarkdown cwd="/tmp/project" text="[Source](/tmp/project/src/main.ts)" />,
    );
    const trigger = screen.getByRole("button");
    await expect.element(trigger).toHaveAttribute("aria-haspopup", "menu");
    await expect.element(trigger).toHaveClass("select-text");
  });

  it.each([true, false])(
    "renders Codex file citations as file chips with parseRawHtml=%s",
    async (parseRawHtml) => {
      await using screen = await render(
        <ChatMarkdown
          cwd="/tmp/project"
          text={
            'Created :codex-file-citation{path="/tmp/project/outputs/report.xlsx" purpose="output"}.'
          }
          lineBreaks={!parseRawHtml}
          parseRawHtml={parseRawHtml}
        />,
      );
      const chip = screen.container.querySelector(".chat-markdown-file-link");
      expect(chip?.textContent).toContain("report.xlsx");
      expect(chip?.getAttribute("data-markdown-copy")).toBe(
        "[report.xlsx](/tmp/project/outputs/report.xlsx)",
      );
      expect(screen.container.textContent).not.toContain("codex-file-citation");
    },
  );

  it("preserves Codex file citation examples inside code", async () => {
    const directive = ':codex-file-citation{path="/tmp/project/outputs/report.xlsx"}';
    await using screen = await render(
      <ChatMarkdown
        cwd="/tmp/project"
        text={`Example: \`${directive}\`\n\n\`\`\`text\n${directive}\n\`\`\``}
      />,
    );
    await vi.waitFor(() => {
      const code = [...screen.container.querySelectorAll("code")].map((node) => node.textContent);
      expect(code).toEqual([directive, `${directive}\n`]);
    });
    expect(screen.container.querySelector(".chat-markdown-file-link")).toBeNull();
  });

  it("does not create a nested link for citations inside link text", async () => {
    const directive = ':codex-file-citation{path="/tmp/project/outputs/report.xlsx"}';
    await using screen = await render(
      <ChatMarkdown cwd="/tmp/project" text={`[See ${directive}](https://example.com)`} />,
    );
    expect(screen.container.querySelector("a")?.textContent).toContain("codex-file-citation");
    expect(screen.container.querySelector(".chat-markdown-file-link")).toBeNull();
  });

  it("renders file citations created by over-indented list recovery", async () => {
    await using screen = await render(
      <ChatMarkdown
        cwd="/tmp/project"
        text={'-       Created :codex-file-citation{path="/tmp/project/outputs/report.xlsx"}'}
      />,
    );
    expect(screen.container.querySelector("pre")).toBeNull();
    expect(screen.container.textContent).toContain("Created ");
    expect(screen.container.querySelector(".chat-markdown-file-link")?.textContent).toContain(
      "report.xlsx",
    );
  });

  it("disambiguates Codex citations with the same basename", async () => {
    await using screen = await render(
      <ChatMarkdown
        cwd="/tmp/project"
        text={
          'Changed :codex-file-citation{path="/tmp/project/src/index.ts"} and :codex-file-citation{path="/tmp/project/test/index.ts"}.'
        }
      />,
    );
    expect(screen.container.textContent).toContain("index.ts · project/src");
    expect(screen.container.textContent).toContain("index.ts · project/test");
  });

  it("preserves rejected citations created by over-indented list recovery", async () => {
    await using malformedScreen = await render(
      <ChatMarkdown
        cwd="/tmp/project"
        text={'Leading text before list.\n\n-       Bad :codex-file-citation{purpose="output"}'}
      />,
    );
    await using nestedLinkScreen = await render(
      <ChatMarkdown
        cwd="/tmp/project"
        text={
          'Leading text before list.\n\n-       [Bad :codex-file-citation{path="/tmp/project/report.xlsx"}](https://example.com)'
        }
      />,
    );
    const nestedLinkText = nestedLinkScreen.container.textContent;

    expect(malformedScreen.container.querySelector("li")?.textContent).toBe(
      'Bad :codex-file-citation{purpose="output"}',
    );
    expect(nestedLinkText).toContain('Bad :codex-file-citation{path="/tmp/project/report.xlsx"}');
  });
});

const ARTIFACT_TEMPLATE_DIRECTIVE =
  '::artifact-template{skill_name="artifact-template-hello-world" skill_directory="/Users/test/.codex/skills/artifact-template-hello-world" display_name="Hello World" artifact_kind="document"}';

describe("ChatMarkdown artifact-template cards", () => {
  it.each([true, false])(
    "renders the Codex result card with parseRawHtml=%s",
    async (parseRawHtml) => {
      await using screen = await render(
        <ChatMarkdown
          cwd="/tmp/project"
          text={ARTIFACT_TEMPLATE_DIRECTIVE}
          parseRawHtml={parseRawHtml}
          onUseArtifactTemplate={() => undefined}
        />,
      );
      const card = screen.container.querySelector("[data-chat-markdown-artifact-template]");
      expect(card?.getAttribute("data-artifact-kind")).toBe("document");
      expect(card?.getAttribute("data-markdown-copy")).toBe("Hello World (Document template)\n\n");
      expect(card?.getAttribute("data-skill-name")).toBe("artifact-template-hello-world");
      expect(card?.textContent).toContain("Hello World");
      expect(card?.textContent).toContain("Document template");
      await expect.element(screen.getByRole("button", { name: "Use template" })).toBeVisible();
      expect(screen.container.textContent).not.toContain("::artifact-template");
      expect(card?.closest("p")).toBeNull();
    },
  );

  it("renders a passive card outside a composer-backed timeline", async () => {
    await using screen = await render(
      <ChatMarkdown cwd="/tmp/project" text={ARTIFACT_TEMPLATE_DIRECTIVE} />,
    );
    expect(screen.container.querySelector("[data-chat-markdown-artifact-template]")).not.toBeNull();
    await expect
      .element(screen.getByRole("button", { name: "Use template" }))
      .not.toBeInTheDocument();
  });

  it("leaves malformed and unfinished artifact-template directives literal", async () => {
    const malformed =
      '::artifact-template{skill_name="artifact-template-hello-world" display_name="Hello World" artifact_kind="document"}';
    const unfinished = ARTIFACT_TEMPLATE_DIRECTIVE.slice(0, -1);

    for (const text of [malformed, unfinished]) {
      await using screen = await render(<ChatMarkdown cwd="/tmp/project" text={text} />);
      expect(screen.container.textContent).toContain("::artifact-template");
      expect(screen.container.querySelector("[data-chat-markdown-artifact-template]")).toBeNull();
    }
  });

  it("leaves escaped and similarly named artifact-template directives literal", async () => {
    for (const text of [
      `\\${ARTIFACT_TEMPLATE_DIRECTIVE}`,
      ARTIFACT_TEMPLATE_DIRECTIVE.replace("::artifact-template", "::artifact-template-extra"),
    ]) {
      await using screen = await render(<ChatMarkdown cwd="/tmp/project" text={text} />);
      expect(screen.container.textContent).toContain("::artifact-template");
      expect(screen.container.querySelector("[data-chat-markdown-artifact-template]")).toBeNull();
    }
  });

  it("preserves artifact-template examples inside code", async () => {
    await using screen = await render(
      <ChatMarkdown
        cwd="/tmp/project"
        text={`\`${ARTIFACT_TEMPLATE_DIRECTIVE}\`\n\n\`\`\`text\n${ARTIFACT_TEMPLATE_DIRECTIVE}\n\`\`\``}
      />,
    );
    await vi.waitFor(() => {
      const code = [...screen.container.querySelectorAll("code")].map((node) => node.textContent);
      expect(code).toEqual([ARTIFACT_TEMPLATE_DIRECTIVE, `${ARTIFACT_TEMPLATE_DIRECTIVE}\n`]);
    });
    expect(screen.container.querySelector("[data-chat-markdown-artifact-template]")).toBeNull();
  });
});

describe("ChatMarkdown heading levels", () => {
  it("exposes headings below the host heading without changing their tags", async () => {
    await using screen = await render(
      <ChatMarkdown
        cwd="/tmp/project"
        text={"# Top\n\n## Section\n\n###### Fine print"}
        headingLevelOffset={3}
      />,
    );
    expect(
      [...screen.container.querySelectorAll("h1, h2, h6")].map((heading) => ({
        tag: heading.tagName,
        id: heading.id,
        level: heading.getAttribute("aria-level"),
        text: heading.textContent,
      })),
    ).toEqual([
      { tag: "H1", id: "user-content-top", level: "4", text: "Top" },
      { tag: "H2", id: "user-content-section", level: "5", text: "Section" },
      { tag: "H6", id: "user-content-fine-print", level: "6", text: "Fine print" },
    ]);
  });

  it("leaves heading levels alone when the markdown is not nested", async () => {
    await using screen = await render(<ChatMarkdown cwd="/tmp/project" text="# Top" />);
    const heading = screen.container.querySelector("h1");
    expect(heading?.id).toBe("user-content-top");
    expect(heading?.textContent).toBe("Top");
    expect(heading?.hasAttribute("aria-level")).toBe(false);
  });
});

describe("ChatMarkdown Windows file links", () => {
  const environmentId = EnvironmentId.make("env-windows");

  it.each([true, false])("preserves drive paths with parseRawHtml=%s", async (parseRawHtml) => {
    await using screen = await render(
      <ChatMarkdown
        cwd="C:/Users/shawn/project"
        environmentId={environmentId}
        text="[Open](C:/Users/shawn/project/src/main.ts)"
        lineBreaks={!parseRawHtml}
        parseRawHtml={parseRawHtml}
      />,
    );
    expect(screen.container.querySelector("a")?.getAttribute("href")).toBe(
      "C:/Users/shawn/project/src/main.ts",
    );
    expect(screen.container.querySelector(".chat-markdown-file-link")).not.toBeNull();
  });

  it.each([true, false])("normalizes backslashes with parseRawHtml=%s", async (parseRawHtml) => {
    await using screen = await render(
      <ChatMarkdown
        cwd="C:/Users/shawn/project"
        environmentId={environmentId}
        text={String.raw`[Open](C:\Users\shawn\project\src\main.ts)`}
        lineBreaks={!parseRawHtml}
        parseRawHtml={parseRawHtml}
      />,
    );
    expect(screen.container.querySelector("a")?.getAttribute("href")).toBe(
      "C:/Users/shawn/project/src/main.ts",
    );
    expect(screen.container.querySelector(".chat-markdown-file-link")).not.toBeNull();
  });

  it.each([true, false])(
    "keeps backslashes CommonMark would read as escapes with parseRawHtml=%s",
    async (parseRawHtml) => {
      await using screen = await render(
        <ChatMarkdown
          cwd="C:/Users/shawn/project"
          environmentId={environmentId}
          text={String.raw`[settings](C:\Users\shawn\.claude\settings.json)`}
          lineBreaks={!parseRawHtml}
          parseRawHtml={parseRawHtml}
        />,
      );
      expect(screen.container.querySelector("a")?.getAttribute("href")).toBe(
        "C:/Users/shawn/.claude/settings.json",
      );
    },
  );

  it.each([true, false])(
    "distinguishes same-named backslash paths with parseRawHtml=%s",
    async (parseRawHtml) => {
      await using screen = await render(
        <ChatMarkdown
          cwd="C:/Users/shawn/project"
          environmentId={environmentId}
          text={String.raw`[Source](C:\Users\shawn\project\src\index.ts) and [Test](C:\Users\shawn\project\test\index.ts)`}
          lineBreaks={!parseRawHtml}
          parseRawHtml={parseRawHtml}
        />,
      );
      expect(screen.container.textContent).toContain("index.ts · project/src");
      expect(screen.container.textContent).toContain("index.ts · project/test");
    },
  );

  it.each([true, false])(
    "does not disambiguate the same file in links and inline code with parseRawHtml=%s",
    async (parseRawHtml) => {
      const path = String.raw`C:\Users\shawn\project\src\main.ts`;
      await using screen = await render(
        <ChatMarkdown
          cwd="C:/Users/shawn/project"
          environmentId={environmentId}
          text={`[Source](${path}) and \`${path}\``}
          lineBreaks={!parseRawHtml}
          parseRawHtml={parseRawHtml}
        />,
      );
      expect(screen.container.querySelectorAll(".chat-markdown-file-link")).toHaveLength(2);
      expect(screen.container.textContent).not.toContain("main.ts ·");
    },
  );

  it.each([true, false])("preserves reference links with parseRawHtml=%s", async (parseRawHtml) => {
    await using screen = await render(
      <ChatMarkdown
        cwd="C:/Users/shawn/project"
        environmentId={environmentId}
        text={"[Open][source]\n\n[source]: C:/Users/shawn/project/src/main.ts"}
        lineBreaks={!parseRawHtml}
        parseRawHtml={parseRawHtml}
      />,
    );
    expect(screen.container.querySelector("a")?.getAttribute("href")).toBe(
      "C:/Users/shawn/project/src/main.ts",
    );
    expect(screen.container.querySelector(".chat-markdown-file-link")).not.toBeNull();
  });

  it.each([true, false])(
    "still rejects unsafe schemes with parseRawHtml=%s",
    async (parseRawHtml) => {
      await using screen = await render(
        <ChatMarkdown
          cwd="C:/Users/shawn/project"
          environmentId={environmentId}
          text="[unsafe](javascript:alert(1)) and [unknown](d:alert(1))"
          lineBreaks={!parseRawHtml}
          parseRawHtml={parseRawHtml}
        />,
      );
      const html = screen.container.innerHTML;
      expect(html).not.toContain("javascript:");
      expect(html).not.toContain("d:alert");
      expect(screen.container.querySelector(".chat-markdown-file-link")).toBeNull();
    },
  );
});

function findHighlights(name: string) {
  return [...(CSS.highlights.get(name) ?? [])].map((range) => range.toString());
}

it("opens a disclosure only when find selects a match inside it", async () => {
  const container = document.createElement("div");
  const openStates = () =>
    [...container.querySelectorAll("[data-markdown-details-open]")].map((node) =>
      node.getAttribute("data-markdown-details-open"),
    );
  function Probe({
    activeOccurrence,
    searching = true,
  }: {
    activeOccurrence: number;
    searching?: boolean;
  }) {
    useThreadFindHighlights({
      container,
      query: searching ? "needle" : "",
      activeRowId: "row",
      activeOccurrence,
      onActiveRange: () => {},
    });
    return (
      <div data-timeline-row-id="row">
        <div data-thread-find-text>
          <MarkdownFindContext value={searching}>
            <ChatMarkdown
              cwd={undefined}
              text={[
                "Visible needle.",
                "<details><summary>Unrelated</summary><p>nothing here</p></details>",
                "<details><summary>Outer</summary><details><summary>Inner</summary><p>needle</p></details></details>",
              ].join("\n\n")}
            />
          </MarkdownFindContext>
        </div>
      </div>
    );
  }
  // Closed panels are unmounted until find starts, as in the app.
  await using screen = await render(<Probe activeOccurrence={0} searching={false} />, {
    container,
  });
  expect(container.textContent).not.toContain("nothing here");
  await screen.rerender(<Probe activeOccurrence={0} />);
  // Selecting the visible match opens nothing; the folded one is counted but not painted.
  expect(openStates()).toEqual(["false", "false", "false"]);
  expect(container.textContent).toContain("nothing here");
  expect(findHighlights("t3-thread-find-active")).toEqual(["needle"]);
  expect(CSS.highlights.get("t3-thread-find")?.size).toBe(0);

  await screen.rerender(<Probe activeOccurrence={1} />);
  // Stepping to the folded match opens its two ancestors, not the unrelated one.
  await vi.waitFor(() => {
    expect(openStates()).toEqual(["false", "true", "true"]);
    expect(findHighlights("t3-thread-find-active")).toEqual(["needle"]);
  });
});

it("keeps Mermaid diagrams rendered until find selects a match in their source", async () => {
  const container = document.createElement("div");
  const diagram = "```mermaid\ngraph TD; Alpha-->Beta\n```";
  function Probe({ query }: { query: string }) {
    useThreadFindHighlights({
      container,
      query,
      activeRowId: "row",
      activeOccurrence: 0,
      onActiveRange: () => {},
    });
    return (
      <div data-timeline-row-id="row">
        <div data-thread-find-text>
          <MarkdownFindContext value={true}>
            <ChatMarkdown cwd={undefined} text={`Needle first.\n\n${diagram}\n\n${diagram}`} />
          </MarkdownFindContext>
        </div>
      </div>
    );
  }
  const diagrams = () => container.querySelectorAll('svg[aria-label="Diagram"]').length;
  await using screen = await render(<Probe query="Needle" />, { container });
  expect(diagrams()).toBe(2);
  await screen.rerender(<Probe query="Alpha" />);
  // Only the diagram holding the selected match switches to source.
  await vi.waitFor(() => {
    expect(diagrams()).toBe(1);
    expect(findHighlights("t3-thread-find-active")).toEqual(["Alpha"]);
  });
});

it.each([
  {
    text: "```mermaid\ngraph TD; SearchSourceAlpha-->B\n```",
    query: "SearchSourceAlpha",
    count: 1,
  },
  {
    text: "★ Insight ─────\nfirst line\nsecond line",
    query: "first line second",
    count: 0,
    lineBreaks: true,
  },
  { text: '```ts title="src/needle.ts"\nconst a = 1;\n```', query: "needle", count: 0 },
  { text: "```weirdlang\nconst a = 1;\n```", query: "weirdlang", count: 0 },
  { text: "Use $test-t3-app now", query: "T3 App Testing", count: 1 },
  { text: "`/tmp/file.ts:42`", query: "file.ts · L42", count: 1, user: true, lineBreaks: true },
  { text: "> [!NOTE]\n> Searchable alert", query: "Searchable alert", count: 1 },
  {
    text: "<details><summary>Folded</summary><p>Hidden needle</p></details>",
    query: "Hidden needle",
    count: 1,
  },
  { text: ARTIFACT_TEMPLATE_DIRECTIVE, query: "Hello World", count: 1, hasTemplateAction: true },
  {
    text: ARTIFACT_TEMPLATE_DIRECTIVE,
    query: "Document template",
    count: 1,
    hasTemplateAction: true,
  },
  { text: ARTIFACT_TEMPLATE_DIRECTIVE, query: "World Document", count: 0, hasTemplateAction: true },
  { text: ARTIFACT_TEMPLATE_DIRECTIVE, query: "Use template", count: 0, hasTemplateAction: true },
])(
  "highlights the indexed occurrences of $query in $text",
  async ({ text, query, count, lineBreaks, user, hasTemplateAction }) => {
    const skills = [{ name: "test-t3-app", displayName: "T3 App Testing" }];

    const container = document.createElement("div");
    function Probe() {
      useThreadFindHighlights({
        container,
        query,
        activeRowId: "row",
        activeOccurrence: 0,
        onActiveRange: () => {},
      });
      return (
        <div data-timeline-row-id="row">
          <div data-thread-find-text>
            <MarkdownFindContext value={true}>
              <ChatMarkdown
                text={text}
                cwd={undefined}
                skills={skills?.map((skill) => ({
                  ...skill,
                  path: `/skills/${skill.name}`,
                  enabled: true,
                }))}
                lineBreaks={lineBreaks ?? false}
                parseRawHtml={!user}
                onUseArtifactTemplate={hasTemplateAction ? () => undefined : undefined}
              />
            </MarkdownFindContext>
          </div>
        </div>
      );
    }
    await using _screen = await render(<Probe />, { container });
    await vi.waitFor(() => {
      const painted = [
        ...findHighlights("t3-thread-find"),
        ...findHighlights("t3-thread-find-active"),
      ];
      expect(painted).toEqual(Array.from({ length: count }, () => query));
    });
    const segments =
      searchableMessageSegments(
        { role: user ? "user" : "assistant", text, streaming: false },
        undefined,
        skills,
      ) ?? [];
    expect(
      segments.reduce((sum, segment) => sum + countThreadSearchOccurrences(segment, query), 0),
    ).toBe(count);
  },
);

describe("ChatMarkdown heading ids", () => {
  it("never gives two headings the same id, even when a suffix matches another heading", async () => {
    await using screen = await render(
      <ChatMarkdown
        cwd="/tmp/project"
        parseRawHtml
        text={
          '## Setup\n\n## Setup\n\n## Setup-1\n\n<h2 id="install-1">Pinned</h2>\n\n## Install\n\n## Install'
        }
      />,
    );
    const ids = [...screen.container.querySelectorAll("h2")].map((heading) => heading.id);
    expect(ids).toEqual([
      "user-content-setup",
      "user-content-setup-1",
      "user-content-setup-1-1",
      "user-content-install-1",
      "user-content-install",
      "user-content-install-2",
    ]);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("ChatMarkdown in-page links", () => {
  it.each([true, false])(
    "scrolls a table-of-contents link to its heading without touching the URL (parseRawHtml=%s)",
    async (parseRawHtml) => {
      await using screen = await render(
        <ChatMarkdown
          cwd="/tmp/project"
          parseRawHtml={parseRawHtml}
          text={
            "- [Operating model](#1-operating-model)\n- [Missing](#nowhere)\n\n## 1. Operating model\n\n## 1. Operating model"
          }
        />,
      );
      using scrollIntoView = vi
        .spyOn(HTMLElement.prototype, "scrollIntoView")
        .mockImplementation(() => {});
      const previousUrl = window.location.href;
      const previousState = window.history.state;
      using _location = {
        [Symbol.dispose]: () => window.history.replaceState(previousState, "", previousUrl),
      };
      window.history.replaceState(previousState, "", "#/env/thread");
      const initialUrl = window.location.href;
      const headings = [...screen.container.querySelectorAll("h2")];
      expect(headings.map((heading) => heading.id)).toEqual([
        "user-content-1-operating-model",
        "user-content-1-operating-model-1",
      ]);

      for (const name of ["Operating model", "Missing"]) {
        const click = new MouseEvent("click", { bubbles: true, cancelable: true });
        await act(() =>
          screen.getByRole("link", { name, exact: true }).element().dispatchEvent(click),
        );
        expect(click.defaultPrevented).toBe(true);
        expect(scrollIntoView.mock.contexts).toEqual([headings[0]]);
        expect(window.location.href).toBe(initialUrl);
      }
    },
  );
});
