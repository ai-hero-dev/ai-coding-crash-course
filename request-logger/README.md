# request-logger

A tiny, dependency-free proxy that sits between a coding-agent CLI and the model
provider's API, and writes a **readable Markdown document of every request** —
the real system prompt, tool definitions, and messages your agent sends to the
model. Built for the AI Coding Crash Course so you can *see* what's actually
going over the wire.

## Run it

```bash
npm run request-logger
# → listening on http://localhost:8787
```

Override the port with `PORT`:

```bash
PORT=9000 npm run request-logger
```

## Point a CLI at it

Set the provider's base URL to the proxy, then use the CLI as normal.

### Claude Code

```bash
ANTHROPIC_BASE_URL=http://localhost:8787 claude
```

This works **even with a Claude subscription (OAuth) login** — the saved login
stays active and traffic just routes through the proxy. Claude Code reads the
env var at startup, so set it before launching.

### Codex

```bash
OPENAI_BASE_URL=http://localhost:8787 codex
```

(or set `openai_base_url` in `~/.codex/config.toml`.)

> **Heads-up:** Codex's *"Sign in with ChatGPT"* login talks to
> `chatgpt.com/backend-api/…`, **not** `api.openai.com`, so it won't route
> through this base-URL override. For a clean Codex capture, authenticate with an
> **OpenAI API key** instead.

## What you get

Every request writes three files to `request-logger/logs/` (gitignored), sharing a
base name like `2026-07-07T14-32-05-123_anthropic`:

| file             | contents                                             |
| ---------------- | ---------------------------------------------------- |
| `.md`            | the readable render — start here                     |
| `.request.txt`   | the verbatim request body (replay it with `curl`)    |
| `.response.txt`  | the verbatim raw SSE response stream                 |

The `.md` uses **XML tags** (`<request>`, `<system-prompt>`, `<tools>`,
`<messages>`, `<response>`, …) to delimit sections, because the captured content
is full of its own Markdown `#` headings. It's **verbatim and complete** — no
truncation — so it's a trustworthy readout of exactly what the model received.
Secret headers (`authorization`, `x-api-key`, `api-key`) are redacted in the
`.md` and never written to the `.txt` files.

## How it works

- One process, one port. It **sniffs the provider from the request path**
  (`/v1/messages` → Anthropic, `/responses` & `/chat/completions` → OpenAI) and
  forwards to the matching upstream (`api.anthropic.com` / `api.openai.com`).
- The real auth header is passed through untouched, so requests authenticate
  normally — the proxy just reads a copy on its way past.
- Responses are **streamed straight back** to the CLI as they arrive, so the
  agent behaves exactly as it would without the proxy.

### Anatomy of a turn

One thing that surprises people: a single message you send is **not** a single
API request. A typical Claude Code turn fans out into:

- **one** real generation call (`POST /v1/messages`) — the only one that
  produces an assistant reply, and the one whose request holds the full system
  prompt + tools; and
- **many** `POST /v1/messages/count_tokens` calls — housekeeping that measures
  token sizes (for the context bar, caching, compaction) and returns only a
  number, never model output.

Because the `count_tokens` calls carry no model output, the proxy **forwards
them but does not log them** — so `logs/` contains just the real turns. You'll
still see a `(count_tokens, not logged)` line in the console when they happen, so
the fan-out is visible.

## Extending it

- **Add a provider:** add an entry to `UPSTREAMS` and a branch in
  `detectProvider()` in `proxy.ts`, then a renderer in `render.ts`.
- **Improve a renderer:** the request/response renderers in `render.ts` are
  plain functions per provider; unknown shapes already fall back to
  pretty-printed JSON, so you can iterate safely.
