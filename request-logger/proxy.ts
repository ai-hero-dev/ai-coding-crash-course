/**
 * request-logger — see every request your coding-agent CLI sends to the model.
 *
 * Sits between a coding agent (Claude Code, Codex) and the model provider's
 * API. It forwards every request untouched — auth header and all — streams the
 * response straight back so the CLI is unaffected, and writes a human-readable
 * Markdown document for each request showing exactly what was sent to the model.
 *
 * Run:   npm run request-logger      (or: npx tsx request-logger/proxy.ts)
 * Point a CLI at it, e.g.:
 *   ANTHROPIC_BASE_URL=http://localhost:8787 claude
 *   OPENAI_BASE_URL=http://localhost:8787 codex
 *
 * Zero runtime dependencies — Node built-ins only.
 */

import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderMarkdown } from "./render";

const PORT = Number(process.env.PORT ?? 8787);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LOG_DIR = path.join(HERE, "logs");

type Provider = "anthropic" | "openai";

const UPSTREAMS: Record<Provider, string> = {
  anthropic: "api.anthropic.com",
  openai: "api.openai.com",
};

/**
 * Sniff the provider from the request path (paths are extremely unlikely to
 * change), with a header-based fallback for stray endpoints (model lists, token
 * counting) that don't carry an obvious provider path.
 */
function detectProvider(
  reqPath: string,
  headers: http.IncomingHttpHeaders
): Provider | null {
  if (reqPath.includes("/messages")) return "anthropic";
  if (
    reqPath.includes("/responses") ||
    reqPath.includes("/chat/completions") ||
    reqPath.includes("/completions")
  ) {
    return "openai";
  }
  // Fallbacks for endpoints without a telltale path.
  if (headers["anthropic-version"] || headers["x-api-key"]) return "anthropic";
  if (headers["authorization"]) return "openai";
  return null;
}

/** count_tokens calls send content to the API but get back only a token count,
 * never a model reply. A single CLI turn fires many of them as housekeeping, so
 * they're pure noise for "what's sent to the model" — we forward them but don't
 * log them. */
function isTokenCount(reqPath: string): boolean {
  return reqPath.includes("count_tokens");
}

/** Build a filesystem-safe base name: 2026-07-07T14-32-05-123_anthropic */
function baseName(provider: Provider): string {
  const iso = new Date().toISOString(); // 2026-07-07T14:32:05.123Z
  const stamp = iso.replace(/:/g, "-").replace(".", "-").replace("Z", "");
  return `${stamp}_${provider}`;
}

/** Headers forwarded upstream. We strip hop-by-hop and encoding headers so the
 * captured response is uncompressed (and therefore readable), and recompute
 * content-length against the buffered body. Auth headers pass through untouched
 * so the real request still authenticates. */
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

function handle(req: http.IncomingMessage, res: http.ServerResponse): void {
  const reqPath = req.url ?? "/";
  const provider = detectProvider(reqPath, req.headers);

  if (!provider) {
    console.warn(`[request-logger] no provider match for ${req.method} ${reqPath}`);
    res.writeHead(404, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        error:
          "request-logger: could not determine provider from path. Expected an " +
          "Anthropic (/v1/messages) or OpenAI (/responses, /chat/completions) endpoint.",
      })
    );
    return;
  }

  const bodyChunks: Buffer[] = [];
  req.on("data", (chunk: Buffer) => bodyChunks.push(chunk));
  req.on("end", () => {
    const body = Buffer.concat(bodyChunks);
    const timestamp = new Date().toISOString();
    const base = baseName(provider);

    const upstreamReq = https.request(
      {
        hostname: UPSTREAMS[provider],
        port: 443,
        path: reqPath,
        method: req.method,
        headers: forwardHeaders(req.headers, body),
      },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
        const responseChunks: Buffer[] = [];
        upstreamRes.on("data", (chunk: Buffer) => {
          responseChunks.push(chunk);
          res.write(chunk); // stream straight back to the CLI, unbuffered
        });
        upstreamRes.on("end", () => {
          res.end();
          const responseRaw = Buffer.concat(responseChunks).toString("utf8");
          writeCapture({
            base,
            provider,
            timestamp,
            method: req.method ?? "POST",
            path: reqPath,
            statusCode: upstreamRes.statusCode ?? 0,
            headers: req.headers,
            requestBody: body.toString("utf8"),
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
      res.end(JSON.stringify({ error: `request-logger upstream error: ${err.message}` }));
    });

    if (body.length > 0) upstreamReq.write(body);
    upstreamReq.end();
  });
}

interface Capture {
  base: string;
  provider: Provider;
  timestamp: string;
  method: string;
  path: string;
  statusCode: number;
  headers: http.IncomingHttpHeaders;
  requestBody: string;
  responseRaw: string;
}

function writeCapture(c: Capture): void {
  if (isTokenCount(c.path)) {
    console.log(`[request-logger] ${c.provider}  ${c.method} ${c.path} -> ${c.statusCode}  (count_tokens, not logged)`);
    return;
  }
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.writeFileSync(path.join(LOG_DIR, `${c.base}.request.txt`), c.requestBody);
    fs.writeFileSync(path.join(LOG_DIR, `${c.base}.response.txt`), c.responseRaw);
    fs.writeFileSync(path.join(LOG_DIR, `${c.base}.md`), renderMarkdown(c));
    console.log(
      `[request-logger] ${c.provider}  ${c.method} ${c.path} -> ${c.statusCode}  logs/${c.base}.md`
    );
  } catch (err) {
    console.error(`[request-logger] failed to write logs: ${(err as Error).message}`);
  }
}

http.createServer(handle).listen(PORT, () => {
  console.log(`[request-logger] listening on http://localhost:${PORT}`);
  console.log(`[request-logger] writing logs to ${LOG_DIR}`);
  console.log(
    `[request-logger] point a CLI at it, e.g. ANTHROPIC_BASE_URL=http://localhost:${PORT} claude`
  );
});
