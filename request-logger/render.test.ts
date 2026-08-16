import { describe, it, expect } from "vitest";
import zlib from "node:zlib";
import { decodeRequestBody, renderMarkdown } from "./render";

const BASE = {
  timestamp: "2026-08-06T10:00:00.000Z",
  method: "POST",
  statusCode: 200,
  headers: {} as Record<string, string | string[] | undefined>,
};

function body(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value));
}

// ---------------------------------------------------------------------------
// Body decoding
// ---------------------------------------------------------------------------

describe("decodeRequestBody", () => {
  it("leaves an uncompressed body alone", () => {
    expect(decodeRequestBody(Buffer.from("hello"), undefined)).toBe("hello");
  });

  it("leaves a body alone when the encoding is identity", () => {
    expect(decodeRequestBody(Buffer.from("hello"), "identity")).toBe("hello");
  });

  it("decodes a zstd body", () => {
    const compressed = zlib.zstdCompressSync(Buffer.from("hello"));
    expect(decodeRequestBody(compressed, "zstd")).toBe("hello");
  });

  it("decodes a gzip body", () => {
    const compressed = zlib.gzipSync(Buffer.from("hello"));
    expect(decodeRequestBody(compressed, "gzip")).toBe("hello");
  });

  it("ignores the case of the encoding", () => {
    const compressed = zlib.gzipSync(Buffer.from("hello"));
    expect(decodeRequestBody(compressed, "GZIP")).toBe("hello");
  });

  it("falls back to the raw bytes when the body will not decode", () => {
    expect(decodeRequestBody(Buffer.from("not compressed"), "zstd")).toBe(
      "not compressed"
    );
  });
});

describe("renderMarkdown with a compressed body", () => {
  it("shows the decoded request", () => {
    const request = {
      model: "gpt-5.1",
      instructions: "You are a careful assistant.",
      input: "hello",
    };
    const out = renderMarkdown({
      ...BASE,
      agent: "Pi (ChatGPT)",
      renderer: "openai",
      path: "/backend-api/codex/responses",
      requestBody: zlib.zstdCompressSync(body(request)),
      requestEncoding: "zstd",
      responseRaw: "",
    });
    expect(out).toContain("You are a careful assistant.");
  });

  it("finds the model in a compressed body", () => {
    const out = renderMarkdown({
      ...BASE,
      agent: "Pi (ChatGPT)",
      renderer: "openai",
      path: "/backend-api/codex/responses",
      requestBody: zlib.zstdCompressSync(body({ model: "gpt-5.1", input: "hi" })),
      requestEncoding: "zstd",
      responseRaw: "",
    });
    expect(out).toContain("**model**: gpt-5.1");
  });
});

// ---------------------------------------------------------------------------
// Anthropic — the existing renderer must keep working
// ---------------------------------------------------------------------------

describe("renderMarkdown for Anthropic", () => {
  const request = {
    model: "claude-sonnet-4-5",
    system: "You are Claude Code.",
    tools: [
      { name: "Read", description: "Read a file", input_schema: { type: "object" } },
    ],
    messages: [{ role: "user", content: "hello" }],
  };

  const out = renderMarkdown({
    ...BASE,
    agent: "Claude Code",
    renderer: "anthropic",
    path: "/v1/messages",
    requestBody: body(request),
    responseRaw:
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}\n' +
      'data: {"type":"content_block_delta","index":0,"delta":{"text":"hi"}}\n',
  });

  it("shows the system prompt", () => {
    expect(out).toContain("You are Claude Code.");
  });

  it("shows the tool name", () => {
    expect(out).toContain("### Read");
  });

  it("shows the message", () => {
    expect(out).toContain('<message index="1" role="user">');
  });

  it("names the agent in the meta block", () => {
    expect(out).toContain("**agent**: Claude Code");
  });

  it("reassembles the streamed reply", () => {
    expect(out).toContain("<assistant-text>");
    expect(out).toContain("hi");
  });
});

// ---------------------------------------------------------------------------
// OpenAI — the existing renderer must keep working
// ---------------------------------------------------------------------------

describe("renderMarkdown for OpenAI", () => {
  const out = renderMarkdown({
    ...BASE,
    agent: "Codex",
    renderer: "openai",
    path: "/v1/responses",
    requestBody: body({
      model: "gpt-5.1",
      instructions: "You are Codex.",
      tools: [{ type: "function", name: "shell", parameters: { type: "object" } }],
      input: [{ type: "message", role: "user", content: "hello" }],
    }),
    responseRaw:
      'data: {"type":"response.output_text.delta","delta":"hi"}\n' +
      'data: {"type":"response.completed","response":{"status":"completed"}}\n',
  });

  it("shows the system prompt", () => {
    expect(out).toContain("You are Codex.");
  });

  it("shows the tool name", () => {
    expect(out).toContain("### shell");
  });

  it("reassembles the streamed reply", () => {
    expect(out).toContain("hi");
  });
});

// ---------------------------------------------------------------------------
// Gemini
// ---------------------------------------------------------------------------

const GEMINI_REQUEST = {
  systemInstruction: {
    role: "user",
    parts: [{ text: "You are the Gemini CLI." }],
  },
  contents: [
    { role: "user", parts: [{ text: "list my files" }] },
    {
      role: "model",
      parts: [{ functionCall: { name: "list_directory", args: { path: "." } } }],
    },
    {
      role: "user",
      parts: [
        {
          functionResponse: {
            name: "list_directory",
            response: { output: "one.ts" },
          },
        },
      ],
    },
  ],
  tools: [
    {
      functionDeclarations: [
        {
          name: "list_directory",
          description: "List the files in a directory",
          parametersJsonSchema: { type: "object", properties: {} },
        },
      ],
    },
  ],
  generationConfig: { temperature: 0, thinkingConfig: { includeThoughts: true } },
};

describe("renderMarkdown for Gemini with an API key", () => {
  const out = renderMarkdown({
    ...BASE,
    agent: "Gemini CLI",
    renderer: "gemini",
    path: "/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse",
    requestBody: body(GEMINI_REQUEST),
    responseRaw: "",
  });

  it("shows the system prompt, which sits beside the messages", () => {
    expect(out).toContain("You are the Gemini CLI.");
  });

  it("puts the system prompt in its own section", () => {
    expect(out).toContain("<system-prompt>");
  });

  it("shows the tool name from inside the double nesting", () => {
    expect(out).toContain("### list_directory");
  });

  it("shows the tool description", () => {
    expect(out).toContain("List the files in a directory");
  });

  it("shows the user message", () => {
    expect(out).toContain("list my files");
  });

  it("uses the model role, not assistant", () => {
    expect(out).toContain('role="model"');
    expect(out).not.toContain('role="assistant"');
  });

  it("shows a tool call", () => {
    expect(out).toContain('<tool-use name="list_directory"');
  });

  it("shows a tool result", () => {
    expect(out).toContain('<tool-result name="list_directory"');
  });

  it("shows the sampling settings from the nested config", () => {
    expect(out).toContain("**temperature**: 0");
  });

  it("takes the model name from the URL, because the body has none", () => {
    expect(out).toContain("**model**: gemini-2.5-pro");
  });
});

describe("renderMarkdown for Gemini with a Google login", () => {
  const out = renderMarkdown({
    ...BASE,
    agent: "Gemini CLI",
    renderer: "gemini",
    path: "/v1internal:streamGenerateContent",
    requestBody: body({
      model: "gemini-2.5-pro",
      project: "some-project",
      request: GEMINI_REQUEST,
    }),
    responseRaw: "",
  });

  it("unwraps the outer envelope and shows the system prompt", () => {
    expect(out).toContain("You are the Gemini CLI.");
  });

  it("unwraps the outer envelope and shows the tools", () => {
    expect(out).toContain("### list_directory");
  });

  it("unwraps the outer envelope and shows the messages", () => {
    expect(out).toContain("list my files");
  });

  it("takes the model name from the body on this route", () => {
    expect(out).toContain("**model**: gemini-2.5-pro");
  });
});

describe("renderMarkdown for a Gemini response", () => {
  const stream =
    'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"Hello"}]}}]}\n' +
    'data: {"candidates":[{"content":{"role":"model","parts":[{"text":" there"}]}}]}\n' +
    'data: {"candidates":[{"content":{"role":"model","parts":[]},"finishReason":"STOP"}],"usageMetadata":{"totalTokenCount":12}}\n';

  const out = renderMarkdown({
    ...BASE,
    agent: "Gemini CLI",
    renderer: "gemini",
    path: "/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse",
    requestBody: body(GEMINI_REQUEST),
    responseRaw: stream,
  });

  it("joins the reply text across events", () => {
    expect(out).toContain("Hello there");
  });

  it("shows the finish reason", () => {
    expect(out).toContain("**finish reason**: STOP");
  });

  it("shows the usage", () => {
    expect(out).toContain("totalTokenCount");
  });

  it("unwraps the response envelope used by the Google login route", () => {
    const wrapped = renderMarkdown({
      ...BASE,
      agent: "Gemini CLI",
      renderer: "gemini",
      path: "/v1internal:streamGenerateContent",
      requestBody: body({ request: GEMINI_REQUEST }),
      responseRaw:
        'data: {"response":{"candidates":[{"content":{"role":"model","parts":[{"text":"Wrapped"}]},"finishReason":"STOP"}]}}\n',
    });
    expect(wrapped).toContain("Wrapped");
  });

  it("separates thinking from the reply", () => {
    const thought = renderMarkdown({
      ...BASE,
      agent: "Gemini CLI",
      renderer: "gemini",
      path: "/v1beta/models/gemini-2.5-pro:streamGenerateContent",
      requestBody: body(GEMINI_REQUEST),
      responseRaw:
        'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"pondering","thought":true},{"text":"answer"}]}}]}\n',
    });
    expect(thought).toContain("<thinking>");
    expect(thought).toContain("pondering");
  });
});

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

describe("renderMarkdown header redaction", () => {
  it("hides the authorization header", () => {
    const out = renderMarkdown({
      ...BASE,
      agent: "Gemini CLI",
      renderer: "gemini",
      headers: { authorization: "Bearer secret-token" },
      path: "/v1beta/models/gemini-2.5-pro:generateContent",
      requestBody: body(GEMINI_REQUEST),
      responseRaw: "",
    });
    expect(out).not.toContain("secret-token");
    expect(out).toContain("[REDACTED]");
  });

  it("hides the x-goog-api-key header", () => {
    const out = renderMarkdown({
      ...BASE,
      agent: "Gemini CLI",
      renderer: "gemini",
      headers: { "x-goog-api-key": "secret-goog-key" },
      path: "/v1beta/models/gemini-2.5-pro:generateContent",
      requestBody: body(GEMINI_REQUEST),
      responseRaw: "",
    });
    expect(out).not.toContain("secret-goog-key");
    expect(out).toContain("[REDACTED]");
  });
});
