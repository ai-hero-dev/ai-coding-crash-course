import { marked, Renderer } from "marked";
import { type Highlighter, createHighlighter } from "shiki";

// ─── Comment Rendering ───
// Deliberately separate from renderMarkdown (~/lib/markdown.server).
//
// renderMarkdown handles lesson content and sales copy, which are written by
// instructors — trusted input, raw HTML allowed through. Comments are written by
// students, so the same treatment would be stored XSS against every reader,
// including the instructor and any admin who opens the questions queue.
//
// This renderer never emits author-supplied HTML:
//   - raw HTML blocks/tags are escaped and shown as literal text
//   - link hrefs are restricted to http/https/mailto and get rel="nofollow"
//   - images are dropped (rendered as their alt text)
//   - everything else goes through marked's own escaping
// Output is still injected with dangerouslySetInnerHTML, so any change here
// needs the same scrutiny.

const SAFE_LINK_PROTOCOLS = ["http:", "https:", "mailto:"];

const COMMENT_LANGS = [
  "typescript",
  "javascript",
  "json",
  "bash",
  "html",
  "css",
  "tsx",
  "jsx",
  "sql",
  "yaml",
  "markdown",
  "text",
  "plaintext",
];

let highlighter: Highlighter | null = null;

async function getHighlighter(): Promise<Highlighter> {
  if (!highlighter) {
    highlighter = await createHighlighter({
      themes: ["github-dark"],
      langs: COMMENT_LANGS,
    });
  }
  return highlighter;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Returns the href only when it uses a protocol we allow. Anything else —
 * javascript:, data:, vbscript:, or an unparseable URL — returns null so the
 * link is downgraded to plain text.
 */
function safeHref(href: string | null): string | null {
  if (!href) return null;

  const trimmed = href.trim();

  // Relative links stay on our own origin, so they're safe.
  if (trimmed.startsWith("/") && !trimmed.startsWith("//")) {
    return trimmed;
  }

  try {
    const url = new URL(trimmed);
    return SAFE_LINK_PROTOCOLS.includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

export async function renderComment(markdown: string): Promise<string> {
  const hl = await getHighlighter();

  const renderer = new Renderer();

  renderer.code = ({ text, lang }) => {
    const language = lang && COMMENT_LANGS.includes(lang) ? lang : "text";
    try {
      return hl.codeToHtml(text, { lang: language, theme: "github-dark" });
    } catch {
      return `<pre><code>${escapeHtml(text)}</code></pre>`;
    }
  };

  // Raw HTML is shown as text, never emitted as markup.
  renderer.html = ({ text }) => escapeHtml(text);

  renderer.link = function ({ href, title, tokens }) {
    const text = this.parser.parseInline(tokens);
    const url = safeHref(href);

    if (!url) return text;

    const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
    return `<a href="${escapeHtml(url)}"${titleAttr} rel="nofollow noopener noreferrer" target="_blank">${text}</a>`;
  };

  // No images in comments — avoids tracking pixels and layout-breaking uploads.
  renderer.image = ({ text }) => escapeHtml(text ?? "");

  return marked.parse(markdown, { renderer, async: false }) as string;
}
