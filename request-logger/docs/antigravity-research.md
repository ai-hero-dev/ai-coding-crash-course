# Adding Antigravity as an agent — research notes (not ready to merge)

Status: **stub / research capture only**. No catalogue entry has been added to
`agents.ts` yet. This file exists so the investigation isn't lost while we wait
on input from whoever requested this — see "Open questions" below.

## Why this might be worth doing

`agents.ts`'s own doc comment says adding an agent is meant to be cheap:

> Adding an eighth agent should be one entry here and nothing else.

"Antigravity" is Google's agentic coding IDE (built by the ex-Windsurf team,
now at Google; GA'd ~Nov 2025). It isn't in the catalogue today. It's plausibly
in scope for the same reason Gemini CLI is.

## The complication: "Antigravity" names two different things

### 1. Antigravity CLI — looks straightforward

Per its docs (`antigravity.google/docs/cli/install`):

- `GOOGLE_GEMINI_BASE_URL` redirects model traffic to a custom endpoint — the
  **same env var already used** by this tool's existing `gemini` → `api-key`
  provider.
- API-key auth is selected via `~/.gemini/antigravity-cli/settings.json`
  (`modelProvider: gemini`), with the credential in `GEMINI_API_KEY`.
  `GOOGLE_API_KEY` and `.env` are explicitly ignored.
- Account-based login is a separate mode (session-based, `/logout` clears it);
  unclear whether it honors the same base URL override.

If this holds up under a real test, adding it is close to copy-pasting the
existing `gemini` → `api-key` provider entry with a new host/label.

### 2. Antigravity IDE — unverified, possibly not proxyable at all

Community reverse-engineering (an archived, non-functional proxy project,
`elad12390/antigravity-proxy`) reports:

- Real traffic goes to an *internal* Cloud Code endpoint, e.g.
  `https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:streamGenerateContent?alt=sse`
  — architecturally the same family as the existing Gemini CLI "Google login"
  route (`cloudcode-pa.googleapis.com`), which suggests the existing `gemini`
  renderer in `render.ts` would likely parse the payload shape correctly
  *if* we could see it.
- But the author reports that plain env-var / MITM / DNS-based redirection did
  **not** work — they describe "a complex handshake followed by socket/TLS-based
  communication" that resisted interception, and archived the project as
  non-functional.
- This is second-hand, from one archived repo, and could be stale by the time
  anyone reads this. It has not been independently verified against a live
  install.
- The IDE also lets the user pick the underlying model (Gemini 3 Pro or Claude
  Sonnet 4.5 have both been reported). A Claude-backed session would need a
  second provider row using the `anthropic` renderer, the same way Pi and
  OpenCode already have multiple provider entries per backend.

If the IDE genuinely can't be redirected, the right shape is a `reason`-only
refusal entry next to Cursor and Amp — but with an honest, distinct reason
(connection-level lock, not "prompt built server-side"), since the underlying
cause looks different even though the practical outcome (nothing to log) is
the same.

## What confirming this needs

Nobody on this has hands-on access to a live Antigravity install yet. To turn
this from research into a real catalogue entry, someone needs to:

1. Set `GOOGLE_GEMINI_BASE_URL=http://localhost:8787` (CLI) and/or
   `CODE_ASSIST_ENDPOINT=http://localhost:8787` (IDE, by analogy with the
   Gemini CLI login route) against a running `npm run request-logger`, and
   report whether anything lands in `request-logger/logs/`.
2. If something lands: paste one captured `.md` in this PR (or attach the raw
   `.request.txt`) so the renderer/host/suffix can be pinned down for real,
   the way every other entry in `agents.ts` has a test backing its suffix.
3. If nothing lands: confirm which redirection knobs were tried, so the
   refusal reason can be written accurately instead of guessed.

## Open questions for the reporter

- Did you mean the **Antigravity IDE** (the editor) or the **Antigravity
  CLI**? They behave very differently for this tool's purposes.
- Have you gotten Antigravity to route through *any* custom base URL or local
  proxy successfully? If so, which setting worked, and what host/path did the
  traffic actually hit?
- Which model were you running it against (Gemini 3 Pro, Claude Sonnet 4.5,
  something else)? That decides whether one provider row is enough or two are
  needed.
- Do you already have a captured request (even a manual curl/mitmproxy dump)
  we could use as a fixture, instead of reverse-engineering from scratch?

## Sources

- https://antigravity.google/docs/cli/install
- https://github.com/elad12390/antigravity-proxy (archived, reports interception failure against the IDE)
- https://github.com/frieser/antigravity-proxy
- https://github.com/alii13/Antigravity-cursor-proxy (different direction — bridges Antigravity's session *into* Cursor, not useful here directly)
- https://www.datacamp.com/tutorial/antigravity-cli
