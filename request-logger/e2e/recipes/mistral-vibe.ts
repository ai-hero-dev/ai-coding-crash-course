import { CANNED_THINKING } from "../fake-upstream";
import type { Recipe } from "../driver";
import { pipTool } from "../install";

const VERSION = "3.1.0";

/**
 * Mistral Vibe through its own catalogue entry (fixed host api.mistral.ai),
 * with a dummy MISTRAL_API_KEY. The fake streams Mistral's list-shaped
 * content: a thinking chunk, then text.
 */
export const mistralVibe: Recipe = {
  name: "mistral-vibe/mistral",
  choice: { agent: "mistral-vibe", provider: "mistral" },
  chat: "mistral",
  install: () => pipTool("mistral-vibe", "mistral-vibe", VERSION),
  env: ({ home, key }) => ({
    MISTRAL_API_KEY: key,
    VIBE_HOME: `${home}/.vibe`,
  }),
  promptArgs: (prompt) => ["-p", prompt],
  modelPath: /^\/v1\/chat\/completions$/,
  extraChecks: ({ capture, seen }) => [
    {
      name: "the upstream saw only the model call as a POST (telemetry off)",
      ok: seen
        .filter((r) => r.method === "POST")
        .every((r) => r.url === "/v1/chat/completions"),
    },
    {
      name: "the capture shows the system prompt as a message",
      ok: capture.includes(`role="system"`),
    },
    {
      name: "the capture shows the streamed thinking",
      ok: capture.includes(`<thinking>\n\n${CANNED_THINKING}\n\n</thinking>`),
    },
  ],
};
