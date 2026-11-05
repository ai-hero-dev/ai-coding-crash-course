import type { Recipe } from "../driver";
import { npmTool } from "../install";

const VERSION = "2.1.318";

/** Claude Code on the Anthropic route, with a dummy API key instead of a login. */
export const claudeCode: Recipe = {
  name: "claude-code/anthropic",
  choice: { agent: "claude-code", provider: "anthropic" },
  install: () => npmTool("claude-code", "@anthropic-ai/claude-code", VERSION),
  env: ({ key }) => ({
    ANTHROPIC_API_KEY: key,
    DISABLE_AUTOUPDATER: "1",
    DISABLE_TELEMETRY: "1",
    DISABLE_ERROR_REPORTING: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  }),
  promptArgs: (prompt) => ["-p", prompt],
  modelPath: /^\/v1\/messages$/,
};

/**
 * Claude Code on Vertex AI (global). CLAUDE_CODE_SKIP_VERTEX_AUTH is Claude
 * Code's own switch for running behind a gateway that adds auth, so it
 * needs no Google credentials, and sends none: the key checks are off.
 *
 * Not in RECIPES yet, because it fails on main, correctly: the vertex entry
 * has no "/v1" suffix, so the call arrives on /projects/… where real Vertex
 * serves /v1/projects/… (a 404 against the real host). Register it with the
 * fix — see NO_RECIPE["claude-code/vertex"].
 */
export const claudeCodeVertex: Recipe = {
  name: "claude-code/vertex",
  choice: { agent: "claude-code", provider: "vertex" },
  install: claudeCode.install,
  env: () => ({
    CLAUDE_CODE_USE_VERTEX: "1",
    CLAUDE_CODE_SKIP_VERTEX_AUTH: "1",
    CLOUD_ML_REGION: "global",
    ANTHROPIC_VERTEX_PROJECT_ID: "e2e-project",
    DISABLE_AUTOUPDATER: "1",
    DISABLE_TELEMETRY: "1",
    DISABLE_ERROR_REPORTING: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  }),
  promptArgs: claudeCode.promptArgs,
  modelPath:
    /^\/v1\/projects\/[^/]+\/locations\/global\/publishers\/anthropic\/models\/[^/]+:streamRawPredict$/,
  sendsKey: false,
};
