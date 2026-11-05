# request-logger e2e

End-to-end checks that drive a real agent CLI through the real proxy against
a local fake upstream, with no paid account and no real key.

```bash
npm run request-logger:e2e                  # every recipe
npm run request-logger:e2e -- codex pi      # only recipes whose name starts so
npm run request-logger:e2e -- --strict      # a skipped recipe fails the run (CI does this)
```

The first run installs each pinned agent under `request-logger/e2e/.tools/`
(gitignored), never globally. Later runs reuse it.

## What one run proves

`driver.ts` does the same thing for every recipe:

1. Starts `fake-upstream.ts`. It answers Anthropic `messages` (and Vertex's
   `:streamRawPredict`), OpenAI `chat/completions` (OpenAI's shape, or
   Mistral's list-shaped content with `chat: "mistral"`), OpenAI `responses`
   and `models`, streamed when the request asks for a stream. Every reply is
   the one canned string `CANNED-REPLY-FROM-FAKE-UPSTREAM`.
2. Starts the real `proxy.ts`, unmodified, with a saved choice for the
   recipe's registry entry and the two test-only variables:
   - `REQUEST_LOGGER_TEST_DIR`: the saved choice and `logs/` live in a
     scratch folder, so your own `.agent-choice.json` and `logs/` are never
     read or written;
   - `REQUEST_LOGGER_TEST_UPSTREAM`: every request is forwarded to the fake
     instead of the entry's real host. The path is kept, so the fake sees
     exactly what the real host would.
3. Reads the command from the banner and writes any setup file the banner
   asked for into a scratch `HOME`.
4. Runs that command, unchanged, with the recipe's prompt arguments after it
   and a dummy key in a minimal environment (none of your own keys).
5. Checks:
   - the printed command is the one `resolveChoice` builds for the entry;
   - the agent exited 0 and printed the canned reply;
   - the model call reached the upstream on the path the real host serves;
   - the dummy key reached the upstream, so auth passes through;
   - a capture shows the prompt and the reply, a streamed reply reassembled
     into `<assistant-text>`;
   - the key header is `[REDACTED]`, and the key is in no log file;
   - your own `.agent-choice.json` and `logs/` are unchanged.

On a failure the run prints what the upstream saw, keeps the scratch folder
and prints its path.

What it cannot prove: that the real host accepts the request (the fake takes
any body), a real model's reply, a browser or subscription sign-in, and
Windows.

## Recipes

A recipe (`recipes/<agent>.ts`) holds only what is particular to one agent:

```ts
export const codex: Recipe = {
  name: "codex/openai",                          // "<agent>/<provider>", or "<agent>" if alwaysCustom
  choice: { agent: "codex", provider: "openai" }, // what the wizard would save
  install: () => npmTool("codex", "@openai/codex", "0.166.0"), // pinned
  env: ({ key }) => ({ OPENAI_API_KEY: key }),   // the dummy key, telemetry off
  promptArgs: (prompt) => ["exec", "--skip-git-repo-check", prompt], // one prompt, then exit
  modelPath: /^\/v1\/responses$/,                // the path the real host serves
};
```

Register it in `recipes/index.ts`. Optional fields: `chat` (the
chat/completions shape), `files` (extra files in the scratch `HOME`),
`sendsKey: false` (a route with no credential at all, which turns the key
checks off), `extraChecks` (checks only this agent needs, given the capture
and every request the upstream saw), `timeoutMs`.

`install` returns `{ skip: reason }` when the agent cannot be installed here
(no network, no `python3`). A plain run reports the skip and passes, and
`--strict` fails on it. Mistral Vibe's recipe needs `python3` with `venv`. Use `npmTool` or `pipTool` from `install.ts`.

Every catalogue entry needs a recipe, or a line in `NO_RECIPE`
(`recipes/index.ts`) saying why it cannot have one. `coverage.test.ts`
enforces this in the unit suite.

## As of this commit

| Entry | Status |
| --- | --- |
| `claude-code/anthropic`, `codex/openai`, `opencode/anthropic`, `opencode/openai`, `pi/anthropic`, `pi/openai`, `mistral-vibe/mistral` | recipe, passes |
| `claude-code/vertex` | recipe written, not registered: the call arrives on `/projects/…` without `/v1`, which real Vertex 404s |
| `codex/chatgpt`, `pi/codex`, `copilot/github`, `gemini/google-login` | need a real login |
| `gemini/api-key`, `antigravity/api-key` | the fake has no Gemini shape yet |
| `omp`, `junie` | see `NO_RECIPE` |
