/**
 * langfuse.ts — Langfuse v4 tracing integration for request-logger.
 *
 * Implements Langfuse v4 best practices:
 * - Observations-first data model using OpenTelemetry SDK & LangfuseSpanProcessor
 * - Attribute propagation (sessionId, userId, tags, metadata)
 * - Overall input/output on the root observation
 * - Observation types: generation for model turns
 * - Redacts sensitive headers and secrets
 * - Non-blocking asynchronous flushing with fail-safe error isolation
 */

import { NodeSDK } from "@opentelemetry/sdk-node";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import {
  startObservation,
  propagateAttributes,
} from "@langfuse/tracing";
import type { ResolvedTarget, RendererId } from "./agents";
import { decodeRequestBody } from "./render";
import type http from "node:http";

let spanProcessor: LangfuseSpanProcessor | null = null;
let otelSdk: NodeSDK | null = null;

const REDACTED_HEADERS = new Set([
  "authorization",
  "x-api-key",
  "api-key",
  "x-goog-api-key",
]);

/**
 * Get or initialize the Langfuse span processor and OpenTelemetry SDK if credentials are configured.
 */
export function getLangfuseProcessor(): LangfuseSpanProcessor | null {
  if (!process.env.LANGFUSE_PUBLIC_KEY && typeof process.loadEnvFile === "function") {
    try {
      process.loadEnvFile();
    } catch {
      // Ignore if .env doesn't exist
    }
  }

  const publicKey = process.env.LANGFUSE_PUBLIC_KEY;
  const secretKey = process.env.LANGFUSE_SECRET_KEY;
  const baseUrl =
    process.env.LANGFUSE_BASE_URL ??
    process.env.LANGFUSE_HOST ??
    "https://cloud.langfuse.com";

  if (!publicKey || !secretKey) {
    return null;
  }

  if (!spanProcessor) {
    spanProcessor = new LangfuseSpanProcessor({
      publicKey,
      secretKey,
      baseUrl,
      flushAt: 1,
      exportMode: "immediate",
    });

    otelSdk = new NodeSDK({
      spanProcessors: [spanProcessor],
    });
    otelSdk.start();
  }

  return spanProcessor;
}

export interface TraceCaptureInput {
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

export interface ParsedLLMPayload {
  model: string;
  input: any;
  output: any;
  usage?: {
    input?: number;
    output?: number;
    total?: number;
    unit?: "TOKENS" | "CHARACTERS" | "MILLISECONDS" | "SECONDS" | "IMAGES" | "REQUESTS";
  };
  metadata: Record<string, any>;
}

/** Redact sensitive headers for trace metadata */
export function sanitizeHeaders(
  headers: http.IncomingHttpHeaders
): Record<string, string> {
  const sanitized: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (REDACTED_HEADERS.has(key.toLowerCase())) {
      sanitized[key] = "[REDACTED]";
    } else if (value !== undefined) {
      sanitized[key] = Array.isArray(value) ? value.join(", ") : String(value);
    }
  }
  return sanitized;
}

/**
 * Extract Session ID from request headers, metadata, or body.
 * Enables automatic session grouping in the Langfuse Sessions view.
 */
export function extractSessionId(
  headers: http.IncomingHttpHeaders,
  reqJson: any,
  agent: string
): string {
  // 1. Direct headers (e.g. x-claude-code-session-id)
  const headerKeys = [
    "x-claude-code-session-id",
    "x-session-id",
    "session-id",
    "session_id",
    "x-conversation-id",
    "conversation-id",
  ];
  for (const k of headerKeys) {
    const val = headers[k];
    if (typeof val === "string" && val.trim()) return val.trim();
  }

  // 2. Direct body properties
  if (typeof reqJson?.session_id === "string" && reqJson.session_id.trim()) {
    return reqJson.session_id.trim();
  }
  if (typeof reqJson?.sessionId === "string" && reqJson.sessionId.trim()) {
    return reqJson.sessionId.trim();
  }
  if (typeof reqJson?.thread_id === "string" && reqJson.thread_id.trim()) {
    return reqJson.thread_id.trim();
  }

  // 3. Metadata fields (e.g. Anthropic/Claude Code user_id JSON string)
  if (reqJson?.metadata) {
    if (typeof reqJson.metadata.session_id === "string" && reqJson.metadata.session_id.trim()) {
      return reqJson.metadata.session_id.trim();
    }
    if (typeof reqJson.metadata.user_id === "string") {
      try {
        const parsed = JSON.parse(reqJson.metadata.user_id);
        if (typeof parsed?.session_id === "string" && parsed.session_id.trim()) {
          return parsed.session_id.trim();
        }
      } catch {
        // Not JSON
      }
    }
  }

  // 4. Default session grouping by agent
  return `session_${agent}`;
}

/**
 * Extract User ID from request headers or metadata.
 */
export function extractUserId(
  headers: http.IncomingHttpHeaders,
  reqJson: any
): string | undefined {
  const headerKeys = ["x-user-id", "user-id", "x-account-id"];
  for (const k of headerKeys) {
    const val = headers[k];
    if (typeof val === "string" && val.trim()) return val.trim();
  }

  if (typeof reqJson?.user === "string" && reqJson.user.trim()) {
    return reqJson.user.trim();
  }
  if (typeof reqJson?.user_id === "string" && reqJson.user_id.trim()) {
    return reqJson.user_id.trim();
  }

  if (reqJson?.metadata) {
    if (typeof reqJson.metadata.user_id === "string") {
      try {
        const parsed = JSON.parse(reqJson.metadata.user_id);
        if (typeof parsed?.account_uuid === "string" && parsed.account_uuid.trim()) {
          return parsed.account_uuid.trim();
        }
        if (typeof parsed?.device_id === "string" && parsed.device_id.trim()) {
          return parsed.device_id.trim();
        }
      } catch {
        return reqJson.metadata.user_id.trim();
      }
    }
  }

  return undefined;
}

/** Extract SSE data lines */
export function extractSSEPayloads(raw: string): any[] {
  const payloads: any[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const match = line.match(/^data:\s?(.*)$/);
    if (!match) continue;
    const data = match[1];
    if (data === "[DONE]" || data.trim() === "") continue;
    try {
      payloads.push(JSON.parse(data));
    } catch {
      // Ignore unparseable lines
    }
  }
  return payloads;
}

/** Parse Anthropic request & response into LLM payload */
export function parseAnthropic(
  reqJson: any,
  rawResponse: string,
  path: string
): ParsedLLMPayload {
  const model = reqJson?.model ?? "claude";
  const input = {
    system: reqJson?.system,
    messages: reqJson?.messages,
    tools: reqJson?.tools,
  };

  const sse = extractSSEPayloads(rawResponse);
  let assistantText = "";
  let toolCalls: any[] = [];
  let promptTokens: number | undefined;
  let completionTokens: number | undefined;

  if (sse.length > 0) {
    const blocks: Record<number, { type: string; text: string; name?: string; id?: string }> = {};
    for (const ev of sse) {
      if (ev.type === "content_block_start") {
        blocks[ev.index] = {
          type: ev.content_block?.type ?? "text",
          text: "",
          name: ev.content_block?.name,
          id: ev.content_block?.id,
        };
      } else if (ev.type === "content_block_delta" && blocks[ev.index]) {
        const d = ev.delta ?? {};
        blocks[ev.index].text += d.text ?? d.partial_json ?? d.thinking ?? "";
      } else if (ev.type === "message_start" && ev.message?.usage) {
        promptTokens = ev.message.usage.input_tokens;
      } else if (ev.type === "message_delta" && ev.usage) {
        completionTokens = ev.usage.output_tokens;
      }
    }

    const ordered = Object.keys(blocks)
      .map(Number)
      .sort((a, b) => a - b);

    for (const idx of ordered) {
      const b = blocks[idx];
      if (b.type === "text" || b.type === "thinking") {
        assistantText += b.text;
      } else if (b.type === "tool_use") {
        let args = {};
        try {
          args = JSON.parse(b.text || "{}");
        } catch {
          args = { raw: b.text };
        }
        toolCalls.push({ id: b.id, name: b.name, arguments: args });
      }
    }
  } else {
    try {
      const json = JSON.parse(rawResponse);
      if (Array.isArray(json.content)) {
        for (const item of json.content) {
          if (item.type === "text") assistantText += item.text ?? "";
          if (item.type === "tool_use") toolCalls.push(item);
        }
      }
      if (json.usage) {
        promptTokens = json.usage.input_tokens;
        completionTokens = json.usage.output_tokens;
      }
    } catch {
      assistantText = rawResponse;
    }
  }

  const output: any = { content: assistantText };
  if (toolCalls.length > 0) output.toolCalls = toolCalls;

  const total =
    promptTokens !== undefined || completionTokens !== undefined
      ? (promptTokens ?? 0) + (completionTokens ?? 0)
      : undefined;

  return {
    model,
    input,
    output,
    usage: total !== undefined ? { input: promptTokens, output: completionTokens, total, unit: "TOKENS" } : undefined,
    metadata: { endpoint: path },
  };
}

/** Parse OpenAI request & response into LLM payload */
export function parseOpenAI(
  reqJson: any,
  rawResponse: string,
  path: string
): ParsedLLMPayload {
  const model = reqJson?.model ?? "openai-model";
  const input = {
    instructions: reqJson?.instructions,
    messages: reqJson?.messages ?? reqJson?.input,
    tools: reqJson?.tools,
  };

  const sse = extractSSEPayloads(rawResponse);
  let assistantText = "";
  const toolCalls: Record<number, { id?: string; name: string; arguments: string }> = {};
  let promptTokens: number | undefined;
  let completionTokens: number | undefined;

  if (sse.length > 0) {
    for (const ev of sse) {
      const choice = ev.choices?.[0];
      const delta = choice?.delta ?? {};
      if (typeof delta.content === "string") assistantText += delta.content;
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? 0;
          toolCalls[idx] ??= { id: tc.id, name: "", arguments: "" };
          if (tc.id) toolCalls[idx].id = tc.id;
          if (tc.function?.name) toolCalls[idx].name += tc.function.name;
          if (tc.function?.arguments) toolCalls[idx].arguments += tc.function.arguments;
        }
      }
      if (ev.usage) {
        promptTokens = ev.usage.prompt_tokens;
        completionTokens = ev.usage.completion_tokens;
      }
    }
  } else {
    try {
      const json = JSON.parse(rawResponse);
      const choice = json.choices?.[0];
      if (choice?.message?.content) assistantText = choice.message.content;
      if (choice?.message?.tool_calls) {
        choice.message.tool_calls.forEach((tc: any, i: number) => {
          toolCalls[i] = { id: tc.id, name: tc.function?.name ?? "", arguments: tc.function?.arguments ?? "" };
        });
      }
      if (json.usage) {
        promptTokens = json.usage.prompt_tokens;
        completionTokens = json.usage.completion_tokens;
      }
    } catch {
      assistantText = rawResponse;
    }
  }

  const toolCallList = Object.values(toolCalls).map((tc) => {
    let parsedArgs = tc.arguments;
    try {
      parsedArgs = JSON.parse(tc.arguments);
    } catch {
      // keep raw string
    }
    return { id: tc.id, name: tc.name, arguments: parsedArgs };
  });

  const output: any = { content: assistantText };
  if (toolCallList.length > 0) output.toolCalls = toolCallList;

  const total =
    promptTokens !== undefined || completionTokens !== undefined
      ? (promptTokens ?? 0) + (completionTokens ?? 0)
      : undefined;

  return {
    model,
    input,
    output,
    usage: total !== undefined ? { input: promptTokens, output: completionTokens, total, unit: "TOKENS" } : undefined,
    metadata: { endpoint: path },
  };
}

/** Parse Gemini request & response into LLM payload */
export function parseGemini(
  reqJson: any,
  rawResponse: string,
  path: string
): ParsedLLMPayload {
  const modelMatch = path.match(/models\/([^:/?]+)/);
  const model = modelMatch ? modelMatch[1] : (reqJson?.model ?? "gemini");

  const input = {
    contents: reqJson?.contents,
    systemInstruction: reqJson?.systemInstruction,
    tools: reqJson?.tools,
  };

  const sse = extractSSEPayloads(rawResponse);
  let assistantText = "";
  const toolCalls: any[] = [];
  let promptTokens: number | undefined;
  let completionTokens: number | undefined;

  const items = sse.length > 0 ? sse : [(() => {
    try { return JSON.parse(rawResponse); } catch { return {}; }
  })()];

  for (const item of items) {
    const candidate = item?.candidates?.[0];
    const parts = candidate?.content?.parts;
    if (Array.isArray(parts)) {
      for (const part of parts) {
        if (typeof part?.text === "string") assistantText += part.text;
        if (part?.functionCall) toolCalls.push(part.functionCall);
      }
    }
    if (item?.usageMetadata) {
      promptTokens = item.usageMetadata.promptTokenCount;
      completionTokens = item.usageMetadata.candidatesTokenCount;
    }
  }

  const output: any = { content: assistantText };
  if (toolCalls.length > 0) output.toolCalls = toolCalls;

  const total =
    promptTokens !== undefined || completionTokens !== undefined
      ? (promptTokens ?? 0) + (completionTokens ?? 0)
      : undefined;

  return {
    model,
    input,
    output,
    usage: total !== undefined ? { input: promptTokens, output: completionTokens, total, unit: "TOKENS" } : undefined,
    metadata: { endpoint: path },
  };
}

/** Extract LLM payload based on renderer */
export function extractLLMPayload(
  renderer: RendererId,
  reqJson: any,
  rawResponse: string,
  path: string
): ParsedLLMPayload {
  if (renderer === "anthropic") return parseAnthropic(reqJson, rawResponse, path);
  if (renderer === "gemini") return parseGemini(reqJson, rawResponse, path);
  return parseOpenAI(reqJson, rawResponse, path);
}

/**
 * Sends trace and generation observations to Langfuse using v4 observations-first model.
 * Non-blocking and failsafe.
 */
export async function traceWithLangfuse(capture: TraceCaptureInput): Promise<void> {
  const processor = getLangfuseProcessor();
  if (!processor) return;

  try {
    const requestText = decodeRequestBody(
      capture.requestBody,
      capture.requestEncoding
    );
    let reqJson: any = null;
    try {
      reqJson = JSON.parse(requestText);
    } catch {
      reqJson = null;
    }

    const payload = extractLLMPayload(
      capture.target.renderer,
      reqJson,
      capture.responseRaw,
      capture.path
    );

    const level = capture.statusCode >= 400 ? "ERROR" : "DEFAULT";
    const sanitizedHeaders = sanitizeHeaders(capture.headers);
    const sessionId = extractSessionId(capture.headers, reqJson, capture.target.agent);
    const userId = extractUserId(capture.headers, reqJson);

    await propagateAttributes(
      {
        traceName: `${capture.target.agentLabel} (${payload.model})`,
        sessionId,
        userId,
        tags: [capture.target.agent, capture.target.provider, "request-logger"],
        metadata: {
          agent: capture.target.agentLabel.slice(0, 200),
          provider: capture.target.providerLabel.slice(0, 200),
          endpoint: `${capture.method} ${capture.path}`.slice(0, 200),
          statusCode: String(capture.statusCode),
          base: capture.base.slice(0, 200),
          sessionId: sessionId.slice(0, 200),
        },
      },
      async () => {
        // In v4 observations-first model, overall input/output lives on the root observation
        const rootSpan = startObservation("request", {
          input: payload.input,
          output: payload.output,
          level,
          statusMessage: `HTTP ${capture.statusCode}`,
          metadata: {
            agent: capture.target.agentLabel,
            provider: capture.target.providerLabel,
            endpoint: `${capture.method} ${capture.path}`,
            statusCode: capture.statusCode,
            headers: sanitizedHeaders,
            base: capture.base,
          },
        });

        const generation = rootSpan.startObservation(
          `${capture.target.agentLabel} Generation`,
          {
            model: payload.model,
            input: payload.input,
            output: payload.output,
            usageDetails: payload.usage
              ? {
                  ...(payload.usage.input !== undefined ? { input: payload.usage.input } : {}),
                  ...(payload.usage.output !== undefined ? { output: payload.usage.output } : {}),
                  ...(payload.usage.total !== undefined ? { total: payload.usage.total } : {}),
                }
              : undefined,
            level,
            statusMessage: `HTTP ${capture.statusCode}`,
            metadata: {
              ...payload.metadata,
              statusCode: capture.statusCode,
            },
          },
          { asType: "generation" }
        );

        generation.end();
        rootSpan.end();
      }
    );

    await processor.forceFlush();
  } catch (err) {
    // Fail-safe: tracing errors must never disrupt proxy or application
    console.error(
      `[request-logger] Langfuse tracing notice: ${(err as Error).message}`
    );
  }
}
