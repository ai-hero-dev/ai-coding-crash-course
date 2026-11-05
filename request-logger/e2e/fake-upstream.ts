/**
 * fake-upstream.ts — a local stand-in for every model provider the e2e
 * recipes need. It answers each model call with one canned reply, in the
 * wire format the request's path asks for, streamed when the request asks
 * for a stream:
 *
 *   POST …/messages            Anthropic Messages (SSE or JSON)
 *   POST …:streamRawPredict    the same, as Claude on Vertex AI routes it
 *   POST …/chat/completions    OpenAI chat completions (SSE or JSON); with
 *                              chat: "mistral", Mistral's list-shaped
 *                              content (a thinking chunk, then text)
 *   POST …/responses           OpenAI Responses (SSE or JSON)
 *   GET  …/models              a one-model list, for agents that discover
 *
 * Anything else gets a 404 and is still recorded, so a recipe can see every
 * request its agent made.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";

export const CANNED_REPLY = "CANNED-REPLY-FROM-FAKE-UPSTREAM";
export const CANNED_THINKING = "canned reasoning from the fake upstream";
export const FAKE_MODEL = "e2e-fake-model";

export type ChatFlavor = "openai" | "mistral";

export interface SeenRequest {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
  /** Which shape the fake answered in, or null for a 404. */
  answeredAs:
    "anthropic" | "openai-chat" | "openai-responses" | "models" | null;
  streamed: boolean;
}

export interface FakeUpstream {
  origin: string;
  seen: SeenRequest[];
  close(): Promise<void>;
}

export interface FakeUpstreamOptions {
  /** The chat/completions shape. Default "openai". */
  chat?: ChatFlavor;
}

function parseJson(body: string): any {
  try {
    return JSON.parse(body);
  } catch {
    return {};
  }
}

function sse(
  res: http.ServerResponse,
  events: Array<{ event?: string; data: unknown }>
): void {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
  });
  for (const { event, data } of events) {
    if (event) res.write(`event: ${event}\n`);
    res.write(
      `data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`
    );
  }
  res.end();
}

function json(res: http.ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(data));
}

function anthropic(res: http.ServerResponse, req: any, stream: boolean): void {
  const model = req.model ?? FAKE_MODEL;
  const usage = { input_tokens: 1, output_tokens: 1 };
  const message = {
    id: "msg_e2e",
    type: "message",
    role: "assistant",
    model,
    content: [{ type: "text", text: CANNED_REPLY }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage,
  };
  if (!stream) return json(res, 200, message);
  const e = (type: string, data: object) => ({
    event: type,
    data: { type, ...data },
  });
  sse(res, [
    e("message_start", {
      message: { ...message, content: [], stop_reason: null, usage },
    }),
    e("content_block_start", {
      index: 0,
      content_block: { type: "text", text: "" },
    }),
    e("content_block_delta", {
      index: 0,
      delta: { type: "text_delta", text: CANNED_REPLY },
    }),
    e("content_block_stop", { index: 0 }),
    e("message_delta", {
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 1 },
    }),
    e("message_stop", {}),
  ]);
}

function openaiChat(
  res: http.ServerResponse,
  req: any,
  stream: boolean,
  flavor: ChatFlavor
): void {
  const model = req.model ?? FAKE_MODEL;
  const usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };
  const base = { id: "chatcmpl-e2e", created: 0, model };
  if (!stream) {
    return json(res, 200, {
      ...base,
      object: "chat.completion",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: CANNED_REPLY },
          finish_reason: "stop",
        },
      ],
      usage,
    });
  }
  const chunk = (choice: object, extra: object = {}) => ({
    data: {
      ...base,
      object: "chat.completion.chunk",
      choices: [{ index: 0, ...choice }],
      ...extra,
    },
  });
  const events =
    flavor === "mistral"
      ? [
          // Mistral's reasoning models stream content as a list of chunks.
          chunk({
            delta: {
              role: "assistant",
              content: [
                {
                  type: "thinking",
                  thinking: [{ type: "text", text: CANNED_THINKING }],
                },
              ],
            },
            finish_reason: null,
          }),
          chunk({ delta: { content: CANNED_REPLY }, finish_reason: null }),
        ]
      : [
          chunk({
            delta: { role: "assistant", content: "" },
            finish_reason: null,
          }),
          chunk({ delta: { content: CANNED_REPLY }, finish_reason: null }),
        ];
  sse(res, [
    ...events,
    chunk({ delta: { content: "" }, finish_reason: "stop" }, { usage }),
    { data: "[DONE]" },
  ]);
}

function openaiResponses(
  res: http.ServerResponse,
  req: any,
  stream: boolean
): void {
  const model = req.model ?? FAKE_MODEL;
  const item = {
    id: "msg_e2e",
    type: "message",
    status: "completed",
    role: "assistant",
    content: [{ type: "output_text", text: CANNED_REPLY, annotations: [] }],
  };
  const usage = {
    input_tokens: 1,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens: 1,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: 2,
  };
  const response = {
    id: "resp_e2e",
    object: "response",
    created_at: 0,
    status: "completed",
    model,
    output: [item],
    usage,
  };
  if (!stream) return json(res, 200, response);
  let seq = 0;
  const e = (type: string, data: object) => ({
    event: type,
    data: { type, sequence_number: seq++, ...data },
  });
  sse(res, [
    e("response.created", {
      response: { ...response, status: "in_progress", output: [], usage: null },
    }),
    e("response.in_progress", {
      response: { ...response, status: "in_progress", output: [], usage: null },
    }),
    e("response.output_item.added", {
      output_index: 0,
      item: { ...item, status: "in_progress", content: [] },
    }),
    e("response.content_part.added", {
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      part: { type: "output_text", text: "", annotations: [] },
    }),
    e("response.output_text.delta", {
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      delta: CANNED_REPLY,
    }),
    e("response.output_text.done", {
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      text: CANNED_REPLY,
    }),
    e("response.content_part.done", {
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      part: item.content[0],
    }),
    e("response.output_item.done", { output_index: 0, item }),
    e("response.completed", { response }),
  ]);
}

export function startFakeUpstream(
  options: FakeUpstreamOptions = {}
): Promise<FakeUpstream> {
  const flavor = options.chat ?? "openai";
  const seen: SeenRequest[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      const parsed = parseJson(body);
      const pathname = new URL(req.url ?? "/", "http://fake").pathname;
      const stream = parsed.stream === true;
      const record: SeenRequest = {
        method: req.method ?? "",
        url: req.url ?? "",
        headers: req.headers,
        body,
        answeredAs: null,
        streamed: false,
      };
      seen.push(record);
      const answer = (as: SeenRequest["answeredAs"], s: boolean) => {
        record.answeredAs = as;
        record.streamed = s;
      };

      if (req.method === "POST" && /count[_-]?tokens$/i.test(pathname)) {
        answer("anthropic", false);
        return json(res, 200, { input_tokens: 1 });
      }
      // Claude on Vertex: Anthropic's shape, routed by URL (…:streamRawPredict).
      if (req.method === "POST" && /:(stream)?rawPredict$/i.test(pathname)) {
        const s = /:streamRawPredict$/i.test(pathname) || stream;
        answer("anthropic", s);
        return anthropic(res, parsed, s);
      }
      if (req.method === "POST" && pathname.endsWith("/messages")) {
        answer("anthropic", stream);
        return anthropic(res, parsed, stream);
      }
      if (req.method === "POST" && pathname.endsWith("/chat/completions")) {
        answer("openai-chat", stream);
        return openaiChat(res, parsed, stream, flavor);
      }
      if (req.method === "POST" && pathname.endsWith("/responses")) {
        answer("openai-responses", stream);
        return openaiResponses(res, parsed, stream);
      }
      if (req.method === "GET" && pathname.endsWith("/models")) {
        answer("models", false);
        return json(res, 200, {
          object: "list",
          data: [
            { id: FAKE_MODEL, object: "model", created: 0, owned_by: "e2e" },
          ],
        });
      }
      json(res, 404, {
        error: {
          message: `fake upstream: nothing at ${req.method} ${pathname}`,
        },
      });
    });
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        origin: `http://127.0.0.1:${port}`,
        seen,
        close: () =>
          new Promise<void>((done) => {
            server.closeAllConnections();
            server.close(() => done());
          }),
      });
    })
  );
}
