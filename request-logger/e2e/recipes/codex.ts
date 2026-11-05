import type { Recipe } from "../driver";
import { npmTool } from "../install";

const VERSION = "0.166.0";

/** Codex on the OpenAI API key route (Responses API), with a dummy key. */
export const codex: Recipe = {
  name: "codex/openai",
  choice: { agent: "codex", provider: "openai" },
  install: () => npmTool("codex", "@openai/codex", VERSION),
  env: ({ key }) => ({ OPENAI_API_KEY: key, CODEX_API_KEY: key }),
  promptArgs: (prompt) => ["exec", "--skip-git-repo-check", prompt],
  modelPath: /^\/v1\/responses$/,
};
