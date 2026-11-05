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
 * Claude Code sends /projects/… with no /v1 when ANTHROPIC_VERTEX_BASE_URL
 * is set; the entry's upstream path prefix (#122) puts the /v1 back, so the
 * call reaches the upstream on /v1/projects/…, the path real Vertex serves.
 */
export const claudeCodeVertex: Recipe = {
  name: "claude-code/vertex",
  choice: { agent: "claude-code", provider: "vertex", region: "global" },
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
