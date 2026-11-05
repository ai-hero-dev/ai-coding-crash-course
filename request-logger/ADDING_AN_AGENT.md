# Adding an agent to request-logger

Each supported agent is one entry in the `AGENTS` catalogue in `agents.ts`.
The wizard, the banner and the routing all read from it, so a new agent
usually touches `agents.ts`, `agents.test.ts`, the README's agent table, and
one e2e recipe.

## 1. Check it can be logged at all

The tool can only show what leaves the student's machine. If the agent
builds its system prompt on its own servers (Cursor, Amp), no proxy can show
it. Add a refusal entry with a `reason` instead of providers.

## 2. Find the three facts, from source or docs

- **The host** it talks to for model calls.
- **The wire format**: `anthropic`, `openai` (chat/completions or
  responses), `gemini`, or `raw`. Add a renderer in `render.ts` only if none
  of these reads it.
- **The override**: the env var, flag or config key that points it at a base
  URL. Cite the source or docs link in a comment next to the entry.

## 3. Write the entry

Give it `upstreamHost`, `renderer`, `suffix`, `env`/`args`, `bin`, and any
`setup` files, `notes` and `warnings`. See the Codex and Pi entries for flags
and config files, and OMP for an agent with no fixed host (`alwaysCustom`).

**Watch the suffix.** It is appended to `http://localhost:PORT` and is
per-agent. Some agents append the whole path themselves and must not have a
`/v1`. Others append only the last segment and must have it. A wrong suffix
gives the student a 404 they cannot explain. The e2e recipe's `modelPath`
catches this.

Add unit tests in `agents.test.ts` for the host, suffix and renderer, and for
the POSIX and PowerShell commands.

## 4. Add an e2e recipe, or explain why it can't have one

**Your PR must add an e2e recipe or explain why it can't.** A recipe is a
small file in `e2e/recipes/` that installs the pinned agent and runs one
prompt. The shared driver does the rest: it runs the real proxy and the exact
command your entry prints against a fake upstream, then checks the capture.
See [`e2e/README.md`](./e2e/README.md).

```bash
npm run request-logger:e2e -- <your-agent>
```

If the agent cannot run headlessly for free (it needs a real login, it is
closed source and not installable, or the fake has no shape for its wire
format yet), add a line to `NO_RECIPE` in `e2e/recipes/index.ts` saying so.
`coverage.test.ts` fails until the entry has one or the other.

## 5. Show the evidence in the PR

- the e2e run's output (every check `PASS`), or the `NO_RECIPE` reason;
- `npx vitest run request-logger` passing;
- what was **not** verified: the real host, a sign-in route, Windows.

CI runs both suites on every PR that touches `request-logger/`.
