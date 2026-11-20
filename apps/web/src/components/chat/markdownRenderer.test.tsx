import {
  CHAT_MARKDOWN_REHYPE_PLUGINS,
  CHAT_MARKDOWN_REMARK_PLUGINS,
} from "@t3tools/shared/markdownPipeline";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import { describe, expect, it, vi } from "vite-plus/test";

import { createIncrementalMarkdownPlugin } from "../../markdown-incremental";
import { createMarkdownRenderer } from "./markdownRenderer";

// Visible in the markup, so every URL attribute must pass through it.
const urlTransform = (url: string) => `${url}#seen`;

describe("createMarkdownRenderer", () => {
  const render = createMarkdownRenderer({
    remarkPlugins: CHAT_MARKDOWN_REMARK_PLUGINS,
    rehypePlugins: CHAT_MARKDOWN_REHYPE_PLUGINS,
    components: {},
    urlTransform,
  });

  it.each([
    '# Title\n\nText with `code`, **bold**, [a link](https://example.com "t") and https://bare.example.com.',
    "![shot](./shot.png) and [file](file:///C:/repo/a.ts) and [bad](javascript:alert(1))",
    "<details><summary>More</summary>\n\nHidden <b>bold</b> <script>x()</script>\n\n</details>",
    "| a | b |\n| - | - |\n| <br> | [x](#frag) |\n\n- [ ] task\n- [x] done",
    '```ts title="a.ts"\nconst a = 1;\n```\n\n> [!WARNING]\n> careful <a>bare</a>',
    "Footnote[^1] and ~~strike~~\n\n[^1]: the note",
    // Each GFM construct the parser skips when its text cannot match, next to one that can.
    "Mail me@example.com, see www.example.com and HTTPS://example.com/a, not [x](https://y.z).",
    "a.b-c_d+e@x.io and @user\n\n`me@x.io` <me@x.io>",
    "A table without pipes\n:--",
    "> | quoted |\n> | - |\n> | body |\n\n- [ ] open\n- [X] done",
    "Escaped www\\.example.com and me&#64;example.com",
    "\ufeffA byte order mark\n\n| a |\n| - |\n| b |",
    "> - | a |\r\n>   | - |\r\n>   | me@x.io |\r\n\n-\t[ ] tab\n\n  ~~lazy~~",
  ])("renders what react-markdown renders: %j", (source) => {
    const expected = renderToStaticMarkup(
      <ReactMarkdown
        remarkPlugins={CHAT_MARKDOWN_REMARK_PLUGINS}
        rehypePlugins={CHAT_MARKDOWN_REHYPE_PLUGINS}
        urlTransform={urlTransform}
      >
        {source}
      </ReactMarkdown>,
    );
    const { element, remember } = render(source);
    expect(renderToStaticMarkup(element)).toBe(expected);
    remember();
    expect(renderToStaticMarkup(render(source).element)).toBe(expected);
  });

  it("renders what react-markdown renders while a reply streams through the incremental parser", () => {
    const reply =
      "```ts\nconst a = 1;\n```\n\n| a | b |\n| - | - |\n| me@x.io | www.x.io |\n\nDone ~~now~~.";
    // As ChatMarkdown streams: one incremental plugin for the reply, a fresh renderer per update.
    const incremental = createIncrementalMarkdownPlugin();
    for (let end = 1; end <= reply.length; end++) {
      const source = reply.slice(0, end);
      const streamed = createMarkdownRenderer({
        remarkPlugins: [...CHAT_MARKDOWN_REMARK_PLUGINS, incremental],
        rehypePlugins: CHAT_MARKDOWN_REHYPE_PLUGINS,
        components: {},
        urlTransform,
      })(source);
      expect(renderToStaticMarkup(streamed.element)).toBe(
        renderToStaticMarkup(
          <ReactMarkdown
            remarkPlugins={CHAT_MARKDOWN_REMARK_PLUGINS}
            rehypePlugins={CHAT_MARKDOWN_REHYPE_PLUGINS}
            urlTransform={urlTransform}
          >
            {source}
          </ReactMarkdown>,
        ),
      );
    }
  });

  it("keeps cached messages when one far larger than the cache is rendered", () => {
    const prepareTree = vi.fn();
    const renderCached = createMarkdownRenderer({
      remarkPlugins: CHAT_MARKDOWN_REMARK_PLUGINS,
      rehypePlugins: [...CHAT_MARKDOWN_REHYPE_PLUGINS, () => prepareTree],
      components: {},
      urlTransform,
    });
    const first = renderCached("Kept *message*");
    first.remember();
    renderCached("x".repeat(600_000)).remember();
    const cached = renderCached("Kept *message*");
    expect(prepareTree).toHaveBeenCalledTimes(2);
    expect(cached.element).not.toBe(first.element);
    expect(renderToStaticMarkup(cached.element)).toBe(renderToStaticMarkup(first.element));
  });
});
