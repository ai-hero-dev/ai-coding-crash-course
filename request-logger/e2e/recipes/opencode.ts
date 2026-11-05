import type { Recipe } from "../driver";
import { npmTool } from "../install";

const VERSION = "1.19.5";

/** OpenCode on the Anthropic route, with the opencode.json the banner prints. */
export const opencode: Recipe = {
  name: "opencode/anthropic",
  choice: { agent: "opencode", provider: "anthropic" },
  install: () => npmTool("opencode", "opencode-ai", VERSION),
  env: ({ key }) => ({ ANTHROPIC_API_KEY: key }),
  promptArgs: (prompt) => ["run", prompt],
  modelPath: /^\/v1\/messages$/,
};

/** OpenCode on the OpenAI API key route (Responses API). */
export const opencodeOpenAI: Recipe = {
  ...opencode,
  name: "opencode/openai",
  choice: { agent: "opencode", provider: "openai" },
  env: ({ key }) => ({ OPENAI_API_KEY: key }),
  modelPath: /^\/v1\/(responses|chat\/completions)$/,
};
