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
import { fileURLToPath } from "node:url";
import { renderMarkdown } from "./render";
import { resolveChoice, shouldLogRequest, type ResolvedTarget } from "./agents";
import { askChoice, loadChoice, saveChoice } from "./config";

const PORT = Number(process.env.PORT ?? 8787);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LOG_DIR = path.join(HERE, "logs");
const STATE_FILE = path.join(HERE, ".agent-choice.json");

// ---------------------------------------------------------------------------
// Proxying
// ---------------------------------------------------------------------------

/** Build a filesystem-safe base name: 2026-07-07T14-32-05-123_claude-code */
function baseName(target: ResolvedTarget): string {
  const iso = new Date().toISOString(); // 2026-07-07T14:32:05.123Z
  const stamp = iso.replace(/:/g, "-").replace(".", "-").replace("Z", "");
  return `${stamp}_${target.agent}`;
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
  target: ResolvedTarget
): void {
  const reqPath = req.url ?? "/";

  const bodyChunks: Buffer[] = [];
  req.on("data", (chunk: Buffer) => bodyChunks.push(chunk));
  req.on("end", () => {
    const body = Buffer.concat(bodyChunks);
    const timestamp = new Date().toISOString();
    const base = baseName(target);
    const encoding = req.headers["content-encoding"];

    const upstreamReq = https.request(
      {
        hostname: target.upstreamHost,
        port: 443,
        path: reqPath,
        method: req.method,
        headers: {
          ...forwardHeaders(req.headers, body),
          host: target.upstreamHost,
        },
      },
      (upstreamRes) => {
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
      }
    );

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

interface Capture {
  base: string;
  target: ResolvedTarget;
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
      `[request-logger] ${label}  ${c.method} ${c.path} -> ${c.statusCode}  (housekeeping, not logged)`
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
      `[request-logger] ${label}  ${c.method} ${c.path} -> ${c.statusCode}  logs/${c.base}.md`
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

function printBanner(target: ResolvedTarget): void {
  const rule = "-".repeat(72);
  console.log("");
  console.log(rule);
  console.log(`  Agent:     ${target.agentLabel} (${target.providerLabel})`);
  console.log(`  Listening: http://localhost:${PORT}`);
  console.log(`  Forwards:  https://${target.upstreamHost}`);
  console.log(`  Logs:      ${LOG_DIR}`);
  console.log(rule);

  for (const file of target.setup) {
    console.log("");
    console.log(`  Put this in ${file.path}:`);
    console.log("");
    for (const line of file.body.split("\n")) {
      console.log(`      ${line}`);
    }
  }

  console.log("");
  console.log(
    target.setup.length > 0
      ? "  Then run your agent in another terminal with:"
      : "  Run your agent in another terminal with:"
  );
  console.log("");
  console.log(`      ${target.command}`);
  console.log("");

  for (const note of target.notes) printWrapped("Note", note);
  for (const warning of target.warnings) printWrapped("Warning", warning);

  console.log("  Using a different agent now? Run: npm run request-logger -- --force");
  console.log(rule);
  console.log("");
}

async function main(): Promise<void> {
  const force = process.argv.includes("--force");

  let choice = force ? null : loadChoice(STATE_FILE);
  if (!choice) {
    choice = await askChoice();
    saveChoice(STATE_FILE, choice);
  }

  let resolution = resolveChoice(choice, { port: PORT });

  // A saved choice the catalogue no longer understands is not the student's
  // fault. Ask again rather than making them find the flag.
  if (resolution.kind === "error") {
    console.log("");
    console.log(`[request-logger] ${resolution.message}`);
    choice = await askChoice();
    saveChoice(STATE_FILE, choice);
    resolution = resolveChoice(choice, { port: PORT });
  }

  if (resolution.kind === "error") {
    console.error(`[request-logger] ${resolution.message}`);
    process.exit(1);
  }

  if (resolution.kind === "refusal") {
    const rule = "-".repeat(72);
    console.log("");
    console.log(rule);
    console.log(`  ${resolution.agentLabel} cannot be logged by this tool.`);
    console.log(rule);
    console.log("");
    for (const line of wrap(resolution.reason, 68)) console.log(`  ${line}`);
    console.log("");
    console.log("  This is worth knowing on its own: some tools send the system");
    console.log("  prompt from your machine, and some build it on their servers.");
    console.log("  Only the first kind can ever be inspected.");
    console.log("");
    console.log("  To follow the lesson, install one of the other agents, then run:");
    console.log("");
    console.log("      npm run request-logger -- --force");
    console.log("");
    return;
  }

  const target = resolution;
  http.createServer((req, res) => handle(req, res, target)).listen(PORT, () => {
    printBanner(target);
  });
}

/** Print a labelled paragraph, indented and wrapped. */
function printWrapped(label: string, text: string): void {
  const lines = wrap(text, 66);
  console.log(`  ${label}: ${lines[0] ?? ""}`);
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

main().catch((err) => {
  console.error(`[request-logger] ${(err as Error).message}`);
  process.exit(1);
});
