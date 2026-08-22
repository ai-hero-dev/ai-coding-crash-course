/**
 * request-logger — see every request your coding agent sends to the model.
 *
 * It sits between a coding agent and the model provider's API. It forwards
 * every request untouched — auth header and all — streams the response straight
 * back so the agent is unaffected, and writes a readable Markdown document for
 * each request showing exactly what was sent to the model.
 *
 * On the first run it asks which agent you use. It saves the answer, prints the
 * exact command for that agent, and forwards to that agent's one upstream host.
 * Run it with --force to choose again.
 *
 * Run:   npm run request-logger
 *        npm run request-logger -- --force
 *
 * Zero runtime dependencies — Node built-ins only.
 */

import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import type { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";
import { styleText } from "node:util";
import { renderMarkdown } from "./render";
import {
  resolveChoice,
  shouldLogRequest,
  type AgentChoice,
  type CustomTarget,
  type ResolvedTarget,
} from "./agents";
import { askChoice, clearChoice, loadChoice, saveChoice } from "./config";

/**
 * A resolved target the proxy can actually route to and render: a catalogue
 * ResolvedTarget or a student-typed CustomTarget. The two are used
 * interchangeably everywhere below except upstreamConnection, which is the
 * one place their upstream host is found differently.
 */
type ProxyTarget = ResolvedTarget | CustomTarget;

const PORT = Number(process.env.PORT ?? 8787);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LOG_DIR = path.join(HERE, "logs");
const STATE_FILE = path.join(HERE, ".agent-choice.json");

// ---------------------------------------------------------------------------
// Proxying
// ---------------------------------------------------------------------------

/** Build a filesystem-safe base name: 2026-07-07T14-32-05-123_claude-code */
function baseName(target: ProxyTarget): string {
  const iso = new Date().toISOString(); // 2026-07-07T14:32:05.123Z
  const stamp = iso.replace(/:/g, "-").replace(".", "-").replace("Z", "");
  return `${stamp}_${target.agent}`;
}

/**
 * Where a target's traffic actually goes: a scheme, a host and a port.
 *
 * A catalogue ResolvedTarget is always HTTPS on 443 — every provider in the
 * catalogue is a public HTTPS API, so this has never needed to vary, and
 * still does not: it is read straight off upstreamHost, unchanged. A
 * CustomTarget can be anything the student typed, including plain HTTP on an
 * arbitrary port (a local Ollama server, say), so its scheme and port are
 * parsed from the base URL instead of assumed.
 */
export function upstreamConnection(target: ProxyTarget): {
  hostname: string;
  port: number;
  useHttps: boolean;
} {
  if (target.kind === "target") {
    return { hostname: target.upstreamHost, port: 443, useHttps: true };
  }
  const url = new URL(target.upstreamBaseUrl);
  const useHttps = url.protocol === "https:";
  return {
    hostname: url.hostname,
    port: url.port ? Number(url.port) : useHttps ? 443 : 80,
    useHttps,
  };
}

/**
 * Headers forwarded upstream. We strip hop-by-hop headers, and we ask for an
 * uncompressed response so the capture is readable, then recompute the length
 * against the buffered body.
 *
 * We deliberately keep `content-encoding`. Some agents compress the request
 * body, and the upstream must receive those bytes exactly as the agent produced
 * them. Only the copy we write to disk is decoded.
 *
 * Auth headers pass through untouched so the real request still authenticates.
 */
function forwardHeaders(
  headers: http.IncomingHttpHeaders,
  body: Buffer
): http.OutgoingHttpHeaders {
  const out: http.OutgoingHttpHeaders = { ...headers };
  delete out["host"];
  delete out["connection"];
  delete out["accept-encoding"]; // force identity so we can read the stream
  delete out["transfer-encoding"];
  delete out["content-length"];
  if (body.length > 0) out["content-length"] = String(body.length);
  return out;
}

function handle(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  target: ProxyTarget
): void {
  const reqPath = req.url ?? "/";

  const bodyChunks: Buffer[] = [];
  req.on("data", (chunk: Buffer) => bodyChunks.push(chunk));
  req.on("end", () => {
    const body = Buffer.concat(bodyChunks);
    const timestamp = new Date().toISOString();
    const base = baseName(target);
    const encoding = req.headers["content-encoding"];
    const { hostname, port, useHttps } = upstreamConnection(target);

    const onUpstreamResponse = (upstreamRes: http.IncomingMessage) => {
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
      const responseChunks: Buffer[] = [];
      upstreamRes.on("data", (chunk: Buffer) => {
        responseChunks.push(chunk);
        res.write(chunk); // stream straight back to the agent, unbuffered
      });
      upstreamRes.on("end", () => {
        res.end();
        const responseRaw = Buffer.concat(responseChunks).toString("utf8");
        writeCapture({
          base,
          target,
          timestamp,
          method: req.method ?? "POST",
          path: reqPath,
          statusCode: upstreamRes.statusCode ?? 0,
          headers: req.headers,
          requestBody: body,
          requestEncoding: Array.isArray(encoding) ? encoding[0] : encoding,
          responseRaw,
        });
      });
    };

    const requestOptions: http.RequestOptions = {
      hostname,
      port,
      path: reqPath,
      method: req.method,
      headers: {
        ...forwardHeaders(req.headers, body),
        host: hostname,
      },
    };
    const upstreamReq = useHttps
      ? https.request(requestOptions, onUpstreamResponse)
      : http.request(requestOptions, onUpstreamResponse);

    upstreamReq.on("error", (err) => {
      console.error(`[request-logger] upstream error: ${err.message}`);
      if (!res.headersSent) {
        res.writeHead(502, { "content-type": "application/json" });
      }
      res.end(
        JSON.stringify({ error: `request-logger upstream error: ${err.message}` })
      );
    });

    if (body.length > 0) upstreamReq.write(body);
    upstreamReq.end();
  });
}

/**
 * Some agents probe the upstream with a WebSocket upgrade before falling
 * back to plain HTTP — Codex on a ChatGPT subscription does this against
 * /backend-api/codex/responses. This proxy is HTTP-only end to end, and
 * letting the attempt through does not fail closed, it stalls forever: a
 * successful upstream upgrade arrives on the outbound request's 'upgrade'
 * event, not 'response', and nothing here listens for it, so Node just
 * closes that socket with no response and no error. Nothing ever calls
 * res.end() on the agent's connection, so the agent is left waiting on a
 * reply that will never come.
 *
 * Answering every upgrade attempt with 426 here, immediately, gives the
 * agent's own fallback logic something concrete to react to instead of
 * silence, so it retries over plain HTTP right away rather than hanging or
 * waiting out its own timeout.
 */
export function rejectUpgrade(req: http.IncomingMessage, socket: Duplex): void {
  console.log(
    dim(
      `[request-logger] ${req.method ?? "GET"} ${req.url ?? "/"} tried a WebSocket upgrade -> 426 (forcing HTTP fallback)`
    )
  );
  socket.end("HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
}

interface Capture {
  base: string;
  target: ProxyTarget;
  timestamp: string;
  method: string;
  path: string;
  statusCode: number;
  headers: http.IncomingHttpHeaders;
  requestBody: Buffer;
  requestEncoding?: string;
  responseRaw: string;
}

function writeCapture(c: Capture): void {
  const label = c.target.agentLabel;

  if (!shouldLogRequest(c.method, c.path, c.target.renderer)) {
    console.log(
      dim(
        `[request-logger] ${label}  ${c.method} ${c.path} -> ${c.statusCode}  (housekeeping, not logged)`
      )
    );
    return;
  }
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    // The raw file keeps the bytes exactly as they arrived, so the request can
    // still be replayed. Only the .md is decoded.
    fs.writeFileSync(path.join(LOG_DIR, `${c.base}.request.txt`), c.requestBody);
    fs.writeFileSync(path.join(LOG_DIR, `${c.base}.response.txt`), c.responseRaw);
    fs.writeFileSync(
      path.join(LOG_DIR, `${c.base}.md`),
      renderMarkdown({
        agent: label,
        renderer: c.target.renderer,
        timestamp: c.timestamp,
        method: c.method,
        path: c.path,
        statusCode: c.statusCode,
        headers: c.headers,
        requestBody: c.requestBody,
        requestEncoding: c.requestEncoding,
        responseRaw: c.responseRaw,
      })
    );
    console.log(
      `${dim(`[request-logger] ${label}  ${c.method} ${c.path} ->`)} ${c.statusCode}  ${bold(
        `logs/${c.base}.md`
      )}`
    );
  } catch (err) {
    console.error(
      `[request-logger] failed to write logs: ${(err as Error).message}`
    );
  }
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

const dim = (text: string) => styleText("dim", text);
const bold = (text: string) => styleText("bold", text);

/** A field in the banner: a dim label, then the value it describes. */
function field(label: string, value: string): void {
  console.log(`  ${dim(label.padEnd(10))} ${value}`);
}

function printBanner(target: ProxyTarget): void {
  const rule = dim("-".repeat(72));
  const forwards =
    target.kind === "target" ? `https://${target.upstreamHost}` : target.upstreamBaseUrl;
  console.log("");
  console.log(rule);
  field("Agent", bold(`${target.agentLabel} (${target.providerLabel})`));
  field("Listening", `http://localhost:${PORT}`);
  field("Forwards", forwards);
  field("Logs", dim(LOG_DIR));
  console.log(rule);

  for (const file of target.setup) {
    console.log("");
    console.log(`  Put this in ${bold(file.path)}:`);
    console.log("");
    for (const line of file.body.split("\n")) {
      console.log(dim(`      ${line}`));
    }
  }

  console.log("");
  console.log(
    target.setup.length > 0
      ? "  Then run your agent in another terminal with:"
      : "  Run your agent in another terminal with:"
  );
  console.log("");
  console.log(`      ${bold(target.command)}`);
  console.log("");

  for (const note of target.notes) printWrapped("Note", note);
  for (const warning of target.warnings) printWrapped("Warning", warning);

  console.log(
    dim("  Using a different agent now? Run: npm run request-logger -- --force")
  );
  // The tool waits on a port, so nothing tells the student it is finished.
  // Say how to stop it here, where they are already reading.
  // The styles are not nested. Both dim and bold close with the same code, so
  // a bold word inside a dim string ends the dim early.
  console.log(dim("  Press ") + bold("Ctrl+C") + dim(" to stop logging."));
  console.log(rule);
  console.log("");
}

/**
 * Ask the wizard, and keep the answer only if it is to be kept.
 *
 * `offerToRemember` is false when the student has already answered that
 * question: --force replaces a preference they chose to keep, so the new answer
 * simply takes its place. An agent that cannot be logged is never saved.
 */
async function ask(offerToRemember: boolean): Promise<AgentChoice> {
  const { choice, remember } = await askChoice({ offerToRemember });
  if (remember) saveChoice(STATE_FILE, choice);
  return choice;
}

async function main(): Promise<void> {
  const force = process.argv.includes("--force");

  // --force forgets the old answer before it asks. The new answer then replaces
  // it, and a choice that is never saved, such as an agent that cannot be
  // logged, leaves nothing stale behind.
  if (force) clearChoice(STATE_FILE);

  let choice = force ? null : loadChoice(STATE_FILE);
  if (!choice) choice = await ask(!force);

  let resolution = resolveChoice(choice, { port: PORT, platform: process.platform });

  // A saved choice the catalogue no longer understands is not the student's
  // fault. Ask again rather than making them find the flag.
  if (resolution.kind === "error") {
    console.log("");
    console.log(`[request-logger] ${resolution.message}`);
    // A saved file exists, so the student already asked to be remembered.
    choice = await ask(false);
    resolution = resolveChoice(choice, { port: PORT, platform: process.platform });
  }

  if (resolution.kind === "error") {
    console.error(`[request-logger] ${resolution.message}`);
    process.exit(1);
  }

  if (resolution.kind === "request") {
    const rule = dim("-".repeat(72));
    const what = resolution.agentLabel
      ? `${resolution.agentLabel} in that setup is`
      : "Your agent is";
    console.log("");
    console.log(rule);
    console.log(`  ${bold(`${what} not in this list yet.`)}`);
    console.log(rule);
    console.log("");
    for (const line of wrap(
      "This list holds the setups that have been tested. Yours can be added. " +
        "Each one needs three facts: the host your agent talks to, the wire " +
        "format it uses, and the command that points it at this tool.",
      68
    )) {
      console.log(`  ${line}`);
    }
    console.log("");
    console.log("  Ask for it here, and say which agent you use:");
    console.log("");
    console.log(`      ${bold(resolution.url)}`);
    console.log("");
    return;
  }

  if (resolution.kind === "refusal") {
    const rule = dim("-".repeat(72));
    console.log("");
    console.log(rule);
    console.log(`  ${bold(resolution.agentLabel)} cannot be logged by this tool.`);
    console.log(rule);
    console.log("");
    for (const line of wrap(resolution.reason, 68)) console.log(`  ${line}`);
    console.log("");
    console.log(
      dim("  This is worth knowing on its own: some tools send the system")
    );
    console.log(
      dim("  prompt from your machine, and some build it on their servers.")
    );
    console.log(dim("  Only the first kind can ever be inspected."));
    console.log("");
    console.log("  To follow the lesson, install one of the other agents, then run:");
    console.log("");
    console.log(`      ${bold("npm run request-logger")}`);
    console.log("");
    return;
  }

  const target = resolution;
  const server = http.createServer((req, res) => handle(req, res, target));
  server.on("upgrade", rejectUpgrade);
  server.listen(PORT, () => {
    printBanner(target);
  });
}

/** Print a labelled paragraph, indented and wrapped. */
function printWrapped(label: string, text: string): void {
  const lines = wrap(text, 66);
  console.log(`  ${bold(`${label}:`)} ${lines[0] ?? ""}`);
  for (const line of lines.slice(1)) console.log(`        ${line}`);
  console.log("");
}

/** Wrap prose to a width, so a long reason reads as a paragraph. */
function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/)) {
    if (line.length + word.length + 1 > width) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

// Only start the wizard and the server when this file is run directly (`npm
// run request-logger`, or `tsx request-logger/proxy.ts`), not when it is
// imported — the tests import pure functions like upstreamConnection from
// this module, and must not trigger the interactive wizard by doing so.
const isMain = path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    console.error(`[request-logger] ${(err as Error).message}`);
    process.exit(1);
  });
}
