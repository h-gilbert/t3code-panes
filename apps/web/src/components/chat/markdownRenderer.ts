import type { Element, Nodes, Root } from "hast";
import { toJsxRuntime, type Components } from "hast-util-to-jsx-runtime";
import { urlAttributes } from "html-url-attributes";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { type PluggableList, unified } from "unified";
import { VFile } from "vfile";

import { remarkParseWithoutUnusedSyntax } from "./markdownSyntaxGates";

export type MarkdownUrlTransform = (url: string, key: string, node: Element) => string;

interface MarkdownRendererOptions {
  readonly remarkPlugins: PluggableList;
  readonly rehypePlugins: PluggableList;
  readonly components: Partial<Components>;
  readonly urlTransform: MarkdownUrlTransform;
}

// A remount reuses the prepared tree. React elements in development can retain
// their rendering component through owner and debug stack references.
const MAX_CACHED_CHARS = 500_000;
const preparedTrees = new Map<string, Root>();
let cachedChars = 0;
let nextRendererId = 0;

// A short block still holds a whole tree.
const ENTRY_OVERHEAD_CHARS = 200;
const entrySize = (key: string) => key.length + ENTRY_OVERHEAD_CHARS;

function remember(key: string, tree: Root) {
  // One huge message would otherwise evict everything else.
  if (entrySize(key) > MAX_CACHED_CHARS / 4) return;
  preparedTrees.set(key, tree);
  cachedChars += entrySize(key);
  for (const oldest of preparedTrees.keys()) {
    if (cachedChars <= MAX_CACHED_CHARS) break;
    preparedTrees.delete(oldest);
    cachedChars -= entrySize(oldest);
  }
}

/** Renders markdown as react-markdown does, with one processor per plugin set. */
export function createMarkdownRenderer({
  remarkPlugins,
  rehypePlugins,
  components,
  urlTransform,
}: MarkdownRendererOptions) {
  const processor = unified()
    .use(remarkParse)
    .use(remarkParseWithoutUnusedSyntax)
    .use(remarkPlugins)
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(rehypePlugins)
    .freeze();
  const keyPrefix = `${nextRendererId++}\u0000`;

  // Literal raw HTML that survived the rehype plugins, and URL attributes, as react-markdown treats them.
  const prepare = (node: Nodes) => {
    if (!("children" in node)) return;
    const { children } = node;
    for (let index = 0; index < children.length; index++) {
      const child = children[index]!;
      if (child.type === "raw") {
        children[index] = { type: "text", value: child.value };
        continue;
      }
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

  return (text: string) => {
    const key = keyPrefix + text;
    let tree = preparedTrees.get(key);
    if (tree === undefined) {
      const file = new VFile(text);
      tree = processor.runSync(processor.parse(file), file) as Root;
      prepare(tree);
    } else {
      // Refresh its place in the eviction order.
      preparedTrees.delete(key);
      preparedTrees.set(key, tree);
    }
    const element = toJsxRuntime(tree, {
      Fragment,
      components,
      ignoreInvalidStyle: true,
      jsx,
      jsxs,
      passKeys: true,
      passNode: true,
    });
    return {
      element,
      remember: () => {
        if (!preparedTrees.has(key)) remember(key, tree);
      },
    };
  };
}
