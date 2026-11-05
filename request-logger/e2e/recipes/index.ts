/**
 * Every e2e recipe, and every catalogue entry that has none, with the reason.
 *
 * coverage.test.ts holds the two lists against agents.ts: a new catalogue
 * entry must land with a recipe here, or with a line in NO_RECIPE that says
 * why it cannot have one. See ../README.md.
 */

import type { Recipe } from "../driver";
import { claudeCode } from "./claude-code";
import { codex } from "./codex";
import { opencode, opencodeOpenAI } from "./opencode";
import { pi, piOpenAI } from "./pi";

export const RECIPES: Recipe[] = [
  claudeCode,
  codex,
  opencode,
  opencodeOpenAI,
  pi,
  piOpenAI,
];

/**
 * Keyed like a recipe's name: "<agent>/<provider>", or "<agent>" for an
 * alwaysCustom agent. Refused agents (Cursor, Amp) need no entry.
 */
export const NO_RECIPE: Record<string, string> = {
  "claude-code/vertex":
    "claudeCodeVertex (claude-code.ts) is written but fails: this entry forwards to /projects/… " +
    "with no /v1, which real Vertex 404s. Register it with the fix (#122).",
  "codex/chatgpt":
    "the ChatGPT route needs a real ChatGPT login (~/.codex/auth.json).",
  "copilot/github":
    "Copilot CLI needs a real GitHub login before it sends anything.",
  "pi/codex": "the ChatGPT route needs a real ChatGPT login.",
  omp: "not yet written: OMP is alwaysCustom, so it needs a custom-target recipe.",
  "gemini/google-login": "the free Google login needs a real Google account.",
  "gemini/api-key": "the fake upstream has no Gemini shape yet.",
  "antigravity/api-key":
    "the fake upstream has no Gemini shape yet, and agy is not on npm.",
  "grok/xai":
    "grok.ts was run on 2026-11-05 (grok 1.0.70): headless `-p` refuses any XAI_API_KEY with " +
    "'Not signed in'; the binary says headless mode needs a grok.com session, or `grok agent stdio` " +
    "for API-key access. Keyless e2e is impossible on this route; it needs a real grok.com login.",
  junie:
    "Junie CLI is closed source and is not installable headlessly for free.",
};
