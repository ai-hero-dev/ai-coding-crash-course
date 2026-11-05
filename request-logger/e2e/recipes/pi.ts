import type { Recipe } from "../driver";
import { npmTool } from "../install";

const VERSION = "0.73.1";

/** Pi on the Anthropic route, with the models.json the banner prints. */
export const pi: Recipe = {
  name: "pi/anthropic",
  choice: { agent: "pi", provider: "anthropic" },
  install: () => npmTool("pi", "@mariozechner/pi-coding-agent", VERSION),
  env: ({ key }) => ({ ANTHROPIC_API_KEY: key }),
  promptArgs: (prompt) => ["-p", prompt],
  modelPath: /^\/v1\/messages$/,
};

/** Pi on the OpenAI API key route. Pi defaults to Anthropic, so it is told which provider. */
export const piOpenAI: Recipe = {
  ...pi,
  name: "pi/openai",
  choice: { agent: "pi", provider: "openai" },
  env: ({ key }) => ({ OPENAI_API_KEY: key }),
  promptArgs: (prompt) => ["--provider", "openai", "-p", prompt],
  modelPath: /^\/v1\/(responses|chat\/completions)$/,
};
