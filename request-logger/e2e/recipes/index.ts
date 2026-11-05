/**
 * Every e2e recipe, and every catalogue entry that has none, with the reason.
 *
 * coverage.test.ts holds the two lists against agents.ts: a new catalogue
 * entry must land with a recipe here, or with a line in NO_RECIPE that says
 * why it cannot have one. See ../README.md.
 */

import type { Recipe } from "../driver";
import { claudeCode, claudeCodeVertex } from "./claude-code";
import { codex } from "./codex";
import { mistralVibe } from "./mistral-vibe";
import { opencode, opencodeOpenAI } from "./opencode";
import { pi, piOpenAI } from "./pi";

export const RECIPES: Recipe[] = [
  claudeCode,
  claudeCodeVertex,
  codex,
  opencode,
  opencodeOpenAI,
  pi,
  piOpenAI,
  mistralVibe,
];

/**
 * Keyed like a recipe's name: "<agent>/<provider>", or "<agent>" for an
 * alwaysCustom agent. Refused agents (Cursor, Amp) need no entry.
 */
export const NO_RECIPE: Record<string, string> = {
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
  junie:
    "Junie CLI is closed source and is not installable headlessly for free.",
};
