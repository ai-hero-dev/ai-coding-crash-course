# request-logger

A small proxy with no dependencies. It sits between your coding agent and the
model provider's API, and writes a **readable Markdown document for every
request**: the real system prompt, the tool definitions, and the messages your
agent sends to the model.

It was built for the AI Coding Crash Course so that you can _see_ what actually
goes over the wire.

## Run it

```bash
npm run request-logger
```

The first time you run it, it asks which agent you use, then which model
provider you use with it. (OMP is the one exception: it has no fixed provider
of its own, so it skips straight to the base URL question below.) Last, it
asks whether to remember your answer. Say no if you swap agents often, and it
asks again every time. It then prints the exact command for your setup, and
starts listening.

It keeps listening until you stop it. Press **Ctrl+C** to stop it. The console
says so too.

Both questions end with **Other, or not sure**. Pick it if your setup is not in
the list, and the tool gives you a link to ask for it.

The provider question has a second way out, too: **Custom base URL**. Pick it
if your provider is not in the list but you know its base URL — a local model
server such as Ollama, or a smaller hosted provider such as DeepSeek, say. It
asks two questions instead of showing you a dead end:

- the base URL of the model server you want to log, for example
  `http://localhost:11434` for Ollama, or `https://api.deepseek.com` for
  DeepSeek; and
- which wire format it speaks — OpenAI-compatible, Anthropic-compatible, or
  "not sure", if you do not know.

If you are not sure, pick "not sure". The tool still logs everything; it just
shows you the raw JSON instead of a fully readable render, because it cannot
safely guess a shape you did not tell it. See "What you get" below.

For **OpenCode** with an **OpenAI-compatible** custom target, and for **every**
**Pi** custom target, the wizard also tries the unauthenticated `/v1/models`
endpoint and offers any model IDs it finds. You can always enter an ID
manually, and the wizard falls back to manual entry if discovery fails.
Endpoints that require credentials for model listing are not supported.

- OpenCode's printed command uses a temporary `OPENCODE_CONFIG_CONTENT`
  provider for that one run, merged with your existing OpenCode configuration
  without editing its file.
- Pi has no such temporary option, so the selected model is written into
  `~/.pi/agent/models.json` alongside the base URL, replacing that provider's
  built-in model list with the one you chose. Without this, Pi would keep
  offering its built-in model names (`gpt-4o`, and the like), which almost
  never exist on a custom server — the agent would start but every turn would
  fail.

To change a remembered answer:

```bash
npm run request-logger -- --force
```

This forgets the old answer first, then keeps the new one in its place. It does
not ask whether to remember, because you already said yes once. If you pick an
agent that cannot be logged, nothing is kept, and the old answer is gone too.

To use a different port:

```bash
PORT=9000 npm run request-logger
```

A remembered answer is kept in `request-logger/.agent-choice.json`, which is
gitignored. It holds your choice only. The host, the renderer and the command are
worked out again on every start, so an update to this tool reaches you without
you having to clear anything.

The one exception is a **Custom base URL** answer. There is no catalogue entry
for it to be worked out from — you typed it — so the base URL and the wire
format you chose are saved in the file too, alongside your choice. OpenCode's
OpenAI-compatible custom route, and every Pi custom route, also save the
selected model ID, so a remembered choice starts without repeating discovery.
Everything else about a custom answer still behaves the same way: change it
any time with `--force`, and it is never kept for an agent that cannot be
logged.

## The agents

The tool prints the correct command for you, so you do not have to copy anything
from this table. It is here so you can see what is supported before you start.

| Agent          | Works | What you need                                 |
| -------------- | ----- | --------------------------------------------- |
| Claude Code    | Yes   | One command. Works with a subscription login. |
| Codex          | Yes   | One flag. A subscription or an API key works. |
| GitHub Copilot | Yes   | Your normal subscription login.               |
| OpenCode       | Yes   | One command, or a config file.                |
| Pi             | Yes   | A config file. Pi has no base URL variable.   |
| OMP            | Yes   | A YAML config file. Point it at any backend.  |
| Gemini CLI     | Yes   | One command. The free Google login works.     |
| Cursor CLI     | No    | Nothing can make it work. See below.          |
| Amp            | No    | Nothing can make it work. See below.          |

Any other provider — a local model server, or a smaller hosted one — works
through **Custom base URL**, above, on any agent in this table except Cursor
and Amp.

### Why Cursor and Amp cannot work

This is the most interesting thing in the whole lesson, so it is worth saying
clearly.

Some vendors build the system prompt **on your machine** and send it to the
model. You can read that, because it goes past your network card.

Some vendors build the system prompt **on their servers**. Your machine sends
your message and very little else. The prompt and the tool list are added after
your request arrives at their server.

Cursor and Amp are the second kind. Search the whole shipped Cursor bundle and
you will find no system prompt text and no tool schemas at all. No proxy can
read what your machine never sends. This is not a limit of this tool. It is a
property of the product.

If you use Cursor or Amp, install one of the other agents to follow the lesson.

## The Observer Effect

Watching a thing can change the thing.

Claude Code trusts exactly one host. When you point it somewhere else, it turns
off tool search. That means it stops deferring tools and writes every tool
schema into the request instead. Your capture is then bigger than a real one and
has a different shape. That is the opposite of what you want from a tool whose
whole job is to show you the truth.

The command this tool prints for you sets `ENABLE_TOOL_SEARCH=true`, which turns
the effect off.

Measured through this tool with the same prompt:

| Run                            | Capture size |
| ------------------------------ | ------------ |
| Base URL only                  | 63,596 bytes |
| With `ENABLE_TOOL_SEARCH=true` | 39,013 bytes |

That is 39% smaller, and the tool-search tool appears only in the second
capture.

## What you get

Every request writes three files to `request-logger/logs/`, which is gitignored.
They share a base name such as `2026-07-07T14-32-05-123_claude-code`:

| File            | Contents                                 |
| --------------- | ---------------------------------------- |
| `.md`           | The readable render. Start here.         |
| `.request.txt`  | The request body exactly as it was sent. |
| `.response.txt` | The raw response stream.                 |

The `.md` file uses **XML tags** (`<request>`, `<system-prompt>`, `<tools>`,
`<messages>`, `<response>`) to mark its sections, because the captured content is
full of its own Markdown headings. It is complete and not truncated, so it is a
trustworthy readout of what the model received.

If you picked "not sure" for a custom base URL's wire format, the `.md` file
holds pretty-printed JSON instead of that fully tagged render — there is no
system prompt or tool section, because the tool was not told the shape needed
to find them. Nothing is lost: it is still the whole request and response, just
less readable. Run with `--force` and pick the real wire format once you know
it, and the tagged render takes over from the next request.

Secret headers (`authorization`, `x-api-key`, `api-key`) are hidden in the `.md`
file and are never written to the `.txt` files.

Some agents compress the request body. The `.md` file shows the decoded body so
that you can read it. The `.request.txt` file keeps the bytes exactly as they
were sent, so you can still replay it.

## How it works

- One process, one port, **one upstream host**. Your choice decides where
  requests go and how they are read. The tool does not guess from the URL,
  because several agents share the same URLs and guessing gets them wrong.
- Your real auth header passes through untouched, so your requests authenticate
  normally. The tool only reads a copy on the way past.
- Responses are **streamed straight back** as they arrive, so your agent behaves
  exactly as it would without the tool.

### One message is not one request

A single message you send is often **not** a single API request. A typical
Claude Code turn fans out into:

- **one** real generation call, which is the only one that produces a reply, and
  the one whose request holds the full system prompt and tools; and
- **many** token-counting calls, which are housekeeping. They measure sizes for
  the context bar, for caching and for compaction, and they return a number
  rather than model output.

Housekeeping calls carry no model output, so the tool **forwards them but does
not log them**. Your logs folder therefore holds real turns only. You still see a
`(housekeeping, not logged)` line in the console when they happen, so the fan-out
stays visible.

Different agents fan out differently, and that is worth watching:

- **OpenCode** never counts tokens. Instead it makes a second call with a small
  model to title the thread, so one turn writes exactly two captures.
- **Pi** never counts tokens at all, so every file is a real turn.
- **Gemini** on the free Google login makes several extra calls that carry no
  prompt. Those are not logged either.

## If your logs folder stays empty

The failure modes here are quiet ones. An empty folder looks the same whichever
of these happened:

1. **You changed agent and forgot to say so.** Run
   `npm run request-logger -- --force`. The line at the top of the console names
   the agent the tool currently thinks you use.
2. **Your agent chose a WebSocket.** This tool reads HTTP. Some Copilot models,
   and Pi's default transport, negotiate a WebSocket instead, and a WebSocket
   turn writes no log at all. The printed command sets the right transport where
   it can.
3. **You are signed in a way that goes around the tool.** A ChatGPT sign-in on
   OpenCode talks to a different host on purpose. Use an API key for that one.
   Codex is different: pick the ChatGPT route in the wizard and it works.
4. **You started your agent before setting the variable.** Agents read the
   variable once, at startup.
5. **You are on an older Codex, or following an older guide.** Codex used to
   read an OPENAI_BASE_URL variable. Version 0.133.0 does not. It ignores the
   variable in silence, so the only sign is an empty logs folder. Use the
   command this tool prints.

## How much this was tested

Be fair to the tool when you judge a failure.

- **Claude Code and OMP are tested end to end.** The measurements above are
  real, and OMP is run daily by the person who built this tool.
- **The others were verified** by reading the published code of each agent and
  by driving them against a local listener. They were not each run through a
  full course of the lesson.
- **A custom base URL is only as tested as the agent it is attached to.** The
  base URL and wire format mechanism itself is tested directly (see
  `agents.test.ts`); a specific third-party server behind it has not
  necessarily been driven end to end.

If one of them is wrong, it is worth reporting, and the fix is likely to be one
line in `agents.ts`.

## Extending it

- **Add an agent:** add one entry to the catalogue in `agents.ts`, giving its
  upstream host, its renderer, its base URL suffix, and its command. That is the
  whole job. The wizard, the banner and the routing all read from there, so
  nothing else needs to change.
- **Add an agent with no fixed upstream at all**, the way OMP has none: give it
  no upstream host, set `alwaysCustom: true`, and give its one provider entry a
  bin and a setup file. The wizard then skips the provider question for it
  entirely and asks the two custom-base-url questions directly. See the OMP
  entry in `agents.ts` for the whole shape.
- **Add a wire format:** add a renderer in `render.ts` and name it on the
  catalogue entry. Unknown shapes already fall back to pretty-printed JSON, so
  you can iterate safely.
- **Watch the base URL suffix.** It is per-agent on purpose and never a global
  rule. Some agents append the whole path to what you give them and so must not
  have a `/v1`. Some append only the last part and so must have one. Getting it
  wrong produces a 404 that is hard to read. There is a test for each one.
- **Nothing to do for a student on an unlisted provider.** "Custom base URL" at
  the provider question already covers that — see the top of this README. It
  is not a per-agent thing to add; every supported agent gets it for free.
