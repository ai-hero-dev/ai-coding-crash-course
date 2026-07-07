import { marked, Renderer } from "marked";
import { type Highlighter, createHighlighter } from "shiki";

let highlighter: Highlighter | null = null;

async function getHighlighter(): Promise<Highlighter> {
  if (!highlighter) {
    highlighter = await createHighlighter({
      themes: ["github-dark"],
      langs: ["typescript", "javascript", "json", "bash", "html", "css", "tsx", "jsx", "sql", "yaml", "markdown", "text", "plaintext"],
    });
  }
  return highlighter;
}

export async function renderMarkdown(markdown: string): Promise<string> {
  const hl = await getHighlighter();

  const renderer = new Renderer();
  renderer.code = ({ text, lang }) => {
    const language = lang || "text";
    try {
      return hl.codeToHtml(text, {
        lang: language,
        theme: "github-dark",
      });
    } catch {
      // Fall back to plain <pre><code> if the language isn't loaded
      const escaped = text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
      return `<pre><code>${escaped}</code></pre>`;
    }
  };

  return marked.parse(markdown, { renderer }) as string;
}
