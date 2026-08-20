import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  sanitizeHeaders,
  extractSSEPayloads,
  extractSessionId,
  extractUserId,
  parseAnthropic,
  parseOpenAI,
  parseGemini,
  extractLLMPayload,
  traceWithLangfuse,
  type TraceCaptureInput,
} from "./langfuse";

describe("Langfuse tracing integration", () => {
  it("extracts session ID from headers or metadata", () => {
    const headers = { "x-claude-code-session-id": "sess-12345" };
    expect(extractSessionId(headers, {}, "claude-code")).toBe("sess-12345");

    const reqJsonWithMetadata = {
      metadata: {
        user_id: JSON.stringify({
          account_uuid: "user-abc",
          session_id: "sess-nested-999",
        }),
      },
    };
    expect(extractSessionId({}, reqJsonWithMetadata, "claude-code")).toBe(
      "sess-nested-999"
    );
  });

  it("extracts user ID from headers or nested metadata", () => {
    const headers = { "x-user-id": "usr-direct" };
    expect(extractUserId(headers, {})).toBe("usr-direct");

    const reqJson = {
      metadata: {
        user_id: JSON.stringify({ account_uuid: "acc-uuid-555" }),
      },
    };
    expect(extractUserId({}, reqJson)).toBe("acc-uuid-555");
  });

  it("sanitizes sensitive headers", () => {
    const headers = {
      authorization: "Bearer secret-token",
      "x-api-key": "sk-ant-12345",
      "content-type": "application/json",
      accept: "text/event-stream",
    };

    const sanitized = sanitizeHeaders(headers);
    expect(sanitized["authorization"]).toBe("[REDACTED]");
    expect(sanitized["x-api-key"]).toBe("[REDACTED]");
    expect(sanitized["content-type"]).toBe("application/json");
  });

  it("extracts SSE payloads correctly", () => {
    const rawSSE = [
      'event: message_start',
      'data: {"type":"message_start","message":{"id":"msg_1"}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello "}}',
      '',
      'data: [DONE]',
    ].join("\n");

    const payloads = extractSSEPayloads(rawSSE);
    expect(payloads).toHaveLength(2);
    expect(payloads[0].type).toBe("message_start");
    expect(payloads[1].delta.text).toBe("Hello ");
  });

  it("parses Anthropic request and streaming response", () => {
    const reqJson = {
      model: "claude-3-7-sonnet-20250219",
      system: "You are a helpful coding assistant.",
      messages: [{ role: "user", content: "Write a function" }],
    };

    const rawResponse = [
      'data: {"type":"message_start","message":{"usage":{"input_tokens":42}}}',
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Here is "}}',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"the code."}}',
      'data: {"type":"message_delta","usage":{"output_tokens":18}}',
    ].join("\n");

    const parsed = parseAnthropic(reqJson, rawResponse, "/v1/messages");
    expect(parsed.model).toBe("claude-3-7-sonnet-20250219");
    expect(parsed.input.system).toBe("You are a helpful coding assistant.");
    expect(parsed.output.content).toBe("Here is the code.");
    expect(parsed.usage).toEqual({
      input: 42,
      output: 18,
      total: 60,
      unit: "TOKENS",
    });
  });

  it("parses OpenAI request and streaming response", () => {
    const reqJson = {
      model: "gpt-4o",
      messages: [{ role: "user", content: "Explain async/await" }],
    };

    const rawResponse = [
      'data: {"choices":[{"delta":{"content":"Async "}}]}',
      'data: {"choices":[{"delta":{"content":"is simple."}}]}',
      'data: {"usage":{"prompt_tokens":15,"completion_tokens":10}}',
      'data: [DONE]',
    ].join("\n");

    const parsed = parseOpenAI(reqJson, rawResponse, "/v1/chat/completions");
    expect(parsed.model).toBe("gpt-4o");
    expect(parsed.output.content).toBe("Async is simple.");
    expect(parsed.usage).toEqual({
      input: 15,
      output: 10,
      total: 25,
      unit: "TOKENS",
    });
  });

  it("parses Gemini request and extracts model from path", () => {
    const reqJson = {
      contents: [{ role: "user", parts: [{ text: "What is Drizzle ORM?" }] }],
    };

    const rawResponse = JSON.stringify({
      candidates: [
        {
          content: {
            parts: [{ text: "Drizzle is a TypeScript ORM." }],
          },
        },
      ],
      usageMetadata: {
        promptTokenCount: 20,
        candidatesTokenCount: 30,
      },
    });

    const parsed = parseGemini(
      reqJson,
      rawResponse,
      "/v1beta/models/gemini-2.0-flash:generateContent"
    );
    expect(parsed.model).toBe("gemini-2.0-flash");
    expect(parsed.output.content).toBe("Drizzle is a TypeScript ORM.");
    expect(parsed.usage).toEqual({
      input: 20,
      output: 30,
      total: 50,
      unit: "TOKENS",
    });
  });

  it("gracefully completes traceWithLangfuse when Langfuse is not configured", async () => {
    delete process.env.LANGFUSE_PUBLIC_KEY;
    delete process.env.LANGFUSE_SECRET_KEY;

    const capture: TraceCaptureInput = {
      base: "test_capture",
      target: {
        kind: "target",
        agent: "claude-code",
        agentLabel: "Claude Code",
        provider: "anthropic",
        providerLabel: "Anthropic",
        upstreamHost: "api.anthropic.com",
        renderer: "anthropic",
        baseUrl: "http://localhost:8787",
        command: "claude",
        setup: [],
        notes: [],
        warnings: [],
      },
      timestamp: new Date().toISOString(),
      method: "POST",
      path: "/v1/messages",
      statusCode: 200,
      headers: { "content-type": "application/json" },
      requestBody: Buffer.from(JSON.stringify({ model: "claude-3-5-sonnet", messages: [] })),
      responseRaw: "",
    };

    await expect(traceWithLangfuse(capture)).resolves.not.toThrow();
  });

  it("traces with v4 observations-first model when Langfuse is configured", async () => {
    process.env.LANGFUSE_PUBLIC_KEY = "pk-lf-test";
    process.env.LANGFUSE_SECRET_KEY = "sk-lf-test";

    const capture: TraceCaptureInput = {
      base: "test_capture_v4",
      target: {
        kind: "target",
        agent: "claude-code",
        agentLabel: "Claude Code",
        provider: "anthropic",
        providerLabel: "Anthropic",
        upstreamHost: "api.anthropic.com",
        renderer: "anthropic",
        baseUrl: "http://localhost:8787",
        command: "claude",
        setup: [],
        notes: [],
        warnings: [],
      },
      timestamp: new Date().toISOString(),
      method: "POST",
      path: "/v1/messages",
      statusCode: 200,
      headers: {
        "content-type": "application/json",
        "x-claude-code-session-id": "sess-test-456",
        authorization: "Bearer secret-val",
      },
      requestBody: Buffer.from(
        JSON.stringify({
          model: "claude-3-5-sonnet",
          messages: [{ role: "user", content: "Hello" }],
        })
      ),
      responseRaw: JSON.stringify({
        content: [{ type: "text", text: "Hello! How can I help?" }],
        usage: { input_tokens: 10, output_tokens: 20 },
      }),
    };

    await expect(traceWithLangfuse(capture)).resolves.not.toThrow();
  });
});
