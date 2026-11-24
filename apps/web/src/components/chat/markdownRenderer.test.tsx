import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { createMarkdownRenderer } from "./markdownRenderer";

// Visible in the markup, so every URL attribute must pass through it.
const urlTransform = (url: string) => `${url}#seen`;

describe("createMarkdownRenderer", () => {
  const renderer = createMarkdownRenderer({
    markdown: { math: false, breaks: false, escapeHtml: false, insights: false, extensions: {} },
    components: {},
    urlTransform,
  });
  const render = (text: string) => renderer.element(renderer.parse(text));
  const parseAndRemember = (text: string) => {
    const entry = renderer.parse(text);
    renderer.remember(text, entry);
    return entry;
  };

  it("passes every URL attribute through the transform", () => {
    const html = renderToStaticMarkup(
      render('![shot](./shot.png) and [a link](https://example.com "t") and <img src="b.png">'),
    );
    expect(html).toContain('src="./shot.png#seen"');
    expect(html).toContain('href="https://example.com#seen"');
    expect(html).toContain('src="b.png#seen"');
  });

  // Only the tree is cached: development React elements retain their rendering component.
  it("reuses a remembered message's tree and builds a fresh element", () => {
    const text = "# Title\n\nText with `code` and **bold**.";
    const entry = parseAndRemember(text);
    const element = renderer.element(entry);
    const cached = renderer.parse(text);
    expect(cached).toBe(entry);
    const cachedElement = renderer.element(cached);
    expect(cachedElement).not.toBe(element);
    expect(renderToStaticMarkup(cachedElement)).toBe(renderToStaticMarkup(element));
  });

  it("keeps cached messages when one far larger than the cache is rendered", () => {
    const entry = parseAndRemember("Kept *message*");
    parseAndRemember("x".repeat(600_000));
    expect(renderer.parse("Kept *message*")).toBe(entry);
  });
});
