// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { relative, resolve } from "node:path";

// Markdown in this app is mostly written by an AI or a pipe working from
// captured screens, pages and files, so outside content can steer its image
// URLs. A remote image loads the moment it renders and sends its URL to that
// server, with no click. MemoizedReactMarkdown (components/markdown.tsx)
// renders only local files as images; each other direct react-markdown
// renderer below was checked to override or exclude `img`.
const REVIEWED_RENDERERS = [
  "app/notification-panel/page.tsx", // img shows alt text
  "components/announcement-body.tsx", // img shows alt text
  "components/markdown.tsx", // MemoizedReactMarkdown: local files only
  "components/notification-bell.tsx", // img shows alt text
  "components/settings/live-view-card.tsx", // allowedElements excludes img
];

// Runtime imports only; `import type` cannot render anything.
const RUNTIME_IMPORT =
  /\b(?:import|export)\s+(?!type\b)[^;'"]*\bfrom\s*["']react-markdown["']|\bimport\(\s*["']react-markdown["']/;

function frontendSourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((dirent) => {
    const path = resolve(directory, dirent.name);
    if (dirent.isDirectory()) {
      return dirent.name === "__tests__" || dirent.name === "node_modules"
        ? []
        : frontendSourceFiles(path);
    }
    if (!/\.(?:ts|tsx)$/.test(dirent.name)) return [];
    if (/\.(?:spec|test)\./.test(dirent.name)) return [];
    return [path];
  });
}

describe("markdown remote images", () => {
  it("renders markdown only through renderers reviewed for remote images", () => {
    const root = process.cwd();
    const renderers = ["app", "components", "lib"]
      .flatMap((dir) => frontendSourceFiles(resolve(root, dir)))
      .filter((file) => RUNTIME_IMPORT.test(readFileSync(file, "utf8")))
      .map((file) => relative(root, file).replaceAll("\\", "/"))
      .sort();

    expect(
      renderers,
      "Render markdown with MemoizedReactMarkdown from components/markdown.tsx. " +
        "If a file must use react-markdown directly, give it an `img` component " +
        "that never loads a remote URL, then add it to REVIEWED_RENDERERS.",
    ).toEqual(REVIEWED_RENDERERS);
  });

  it.each([
    [`import ReactMarkdown from "react-markdown";`, true],
    [`import ReactMarkdown, { defaultUrlTransform, Options } from 'react-markdown'`, true],
    [`import {\n  MarkdownHooks,\n} from "react-markdown";`, true],
    [`export { default } from "react-markdown";`, true],
    [`const Markdown = await import("react-markdown");`, true],
    [`import type { Options } from "react-markdown";`, false],
    [`import remarkGfm from "remark-gfm";`, false],
  ])("detects runtime react-markdown imports in %s", (source, expected) => {
    expect(RUNTIME_IMPORT.test(source)).toBe(expected);
  });
});
