# request-logger

A small proxy with no dependencies. It sits between your coding agent and the
model provider's API, and writes a **readable Markdown document for every
request**: the real system prompt, the tool definitions, and the messages your
agent sends to the model.

It was built for the AI Coding Crash Course so that you can *see* what actually
goes over the wire.

## Run it

```bash
npm run request-logger
```

The first time you run it, it asks which agent you use. If your agent can drive
more than one model provider, it asks which provider. It then remembers your
answer, prints the exact command for your setup, and starts listening.

To change your answer later:

```bash
npm run request-logger -- --force
```

To use a different port:

```bash
PORT=9000 npm run request-logger
```

Your answer is kept in `request-logger/.agent-choice.json`, which is gitignored.
It holds your choice only. The host, the renderer and the command are worked out
again on every start, so an update to this tool reaches you without you having
to clear anything.

## The agents

The tool prints the correct command for you, so you do not have to copy anything
from this table. It is here so you can see what is supported before you start.

| Agent            | Works | What you need                                   |
| ---------------- | ----- | ----------------------------------------------- |
| Claude Code      | Yes   | One command. Works with a subscription login.    |
| Codex            | Yes   | An OpenAI API key.                               |
| GitHub Copilot   | Yes   | Your normal subscription login.                  |
| Cursor CLI       | No    | Nothing can make it work. See below.             |
| OpenCode         | Yes   | One command, or a config file.                   |
| Pi               | Yes   | A config file. Pi has no base URL variable.      |
| Gemini CLI       | Yes   | One command. The free Google login works.        |
| Amp              | No    | Nothing can make it work. See below.             |

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

| Run                             | Capture size |
| ------------------------------- | ------------ |
| Base URL only                    | 63,596 bytes |
| With `ENABLE_TOOL_SEARCH=true`   | 39,013 bytes |

That is 39% smaller, and the tool-search tool appears only in the second
capture.

## What you get

Every request writes three files to `request-logger/logs/`, which is gitignored.
They share a base name such as `2026-07-07T14-32-05-123_claude-code`:

| File            | Contents                                             |
| --------------- | ---------------------------------------------------- |
| `.md`           | The readable render. Start here.                     |
| `.request.txt`  | The request body exactly as it was sent.             |
| `.response.txt` | The raw response stream.                             |

The `.md` file uses **XML tags** (`<request>`, `<system-prompt>`, `<tools>`,
`<messages>`, `<response>`) to mark its sections, because the captured content is
full of its own Markdown headings. It is complete and not truncated, so it is a
trustworthy readout of what the model received.

Secret headers (`authorization`, `x-api-key`, `api-key`) are hidden in the `.md`
file and are never written to the `.txt` files.

Some agents compress the request body. The `.md` file shows the decoded body so
that you can read it. The `.request.txt` file keeps the bytes exactly as they
were sent, so you can still replay it.

## How it works

- One process, one port, **one upstream host**. Your saved choice decides where
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
   Codex, and a ChatGPT sign-in on OpenCode, both talk to a different host on
   purpose. Use an API key for those.
4. **You started your agent before setting the variable.** Agents read the
   variable once, at startup.

## How much this was tested

Be fair to the tool when you judge a failure.

- **Claude Code is tested end to end.** The measurements above are real.
- **The others were verified** by reading the published code of each agent and
  by driving them against a local listener. They were not each run through a
  full course of the lesson.

If one of them is wrong, it is worth reporting, and the fix is likely to be one
line in `agents.ts`.

## Extending it

- **Add an agent:** add one entry to the catalogue in `agents.ts`, giving its
  upstream host, its renderer, its base URL suffix, and its command. That is the
  whole job. The wizard, the banner and the routing all read from there, so
  nothing else needs to change.
- **Add a wire format:** add a renderer in `render.ts` and name it on the
  catalogue entry. Unknown shapes already fall back to pretty-printed JSON, so
  you can iterate safely.
- **Watch the base URL suffix.** It is per-agent on purpose and never a global
  rule. Some agents append the whole path to what you give them and so must not
  have a `/v1`. Some append only the last part and so must have one. Getting it
  wrong produces a 404 that is hard to read. There is a test for each one.
