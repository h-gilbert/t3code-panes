import type { Element, Nodes, Root } from "hast";
import { toJsxRuntime, type Components } from "hast-util-to-jsx-runtime";
import { urlAttributes } from "html-url-attributes";
import type { ReactElement } from "react";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";

import { wordsHast, type WordsHastOptions } from "../../markdown/wordsHast";

export type MarkdownUrlTransform = (url: string, key: string, node: Element) => string;

interface MarkdownRendererOptions {
  readonly markdown: WordsHastOptions;
  readonly components: Partial<Components>;
  readonly urlTransform: MarkdownUrlTransform;
}

// A remount reuses the prepared tree. React elements in development can retain
// their rendering component through owner and debug stack references, so only trees are cached.
const MAX_CACHED_CHARS = 500_000;
interface Rendered {
  readonly tree: Root;
}
const rendered = new Map<string, Rendered>();
let cachedChars = 0;
let nextRendererId = 0;

// A short block still holds a whole tree.
const ENTRY_OVERHEAD_CHARS = 200;
const entrySize = (key: string) => key.length + ENTRY_OVERHEAD_CHARS;

function remember(key: string, entry: Rendered) {
  // One huge message would otherwise evict everything else.
  if (entrySize(key) > MAX_CACHED_CHARS / 4) return;
  rendered.set(key, entry);
  cachedChars += entrySize(key);
  for (const oldest of rendered.keys()) {
    if (cachedChars <= MAX_CACHED_CHARS) break;
    rendered.delete(oldest);
    cachedChars -= entrySize(oldest);
  }
}

/** Renders markdown with Words, keeping one parse cache per option set. */
export function createMarkdownRenderer({
  markdown,
  components,
  urlTransform,
}: MarkdownRendererOptions) {
  const keyPrefix = `${nextRendererId++}\u0000`;

  // URL attributes, as react-markdown transformed them.
  const prepare = (node: Nodes) => {
    if (!("children" in node)) return;
    for (const child of node.children) {
      if (child.type !== "element") continue;
      const { properties } = child;
      for (const key in properties) {
        if (!Object.hasOwn(urlAttributes, key)) continue;
        const tags = urlAttributes[key];
        if (tags === null || tags?.includes(child.tagName)) {
          properties[key] = urlTransform(String(properties[key] || ""), key, child);
        }
      }
      prepare(child);
    }
  };

  const parse = (text: string): Rendered => {
    const key = keyPrefix + text;
    const cached = rendered.get(key);
    if (cached !== undefined) {
      // Refresh its place in the eviction order.
      rendered.delete(key);
      rendered.set(key, cached);
      return cached;
    }
    const tree = wordsHast(text, markdown);
    prepare(tree);
    return { tree };
  };

  return {
    /** A cached entry, or a fresh one that `remember` can keep. Cached trees are shared, so callers must not change them. */
    parse,
    element: (entry: Rendered): ReactElement =>
      toJsxRuntime(entry.tree, {
        Fragment,
        components,
        ignoreInvalidStyle: true,
        jsx,
        jsxs,
        passKeys: true,
        passNode: true,
      }),
    remember(text: string, entry: Rendered) {
      const key = keyPrefix + text;
      if (!rendered.has(key)) remember(key, entry);
    },
  };
}
