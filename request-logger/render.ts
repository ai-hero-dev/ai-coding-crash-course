/**
 * render.ts — turns a captured request/response into a readable Markdown doc.
 *
 * Design rules (locked):
 *  - Structural sections are delimited by XML tags, NOT Markdown headings,
 *    because the captured content (system prompts especially) is full of its
 *    own `#` headings that would otherwise collide with document structure.
 *  - Verbatim and complete: no truncation, no summarisation, no dedup. The one
 *    exception is base64 image data, which is binary (not "what's sent to the
 *    model as readable text") and is preserved untouched in the .request.txt.
 *  - Both providers get a real renderer; unexpected shapes fall back to
 *    pretty-printed JSON so information is never lost.
 */

interface RenderInput {
  provider: "anthropic" | "openai";
  timestamp: string;
  method: string;
  path: string;
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  requestBody: string;
  responseRaw: string;
}

const REDACT = new Set(["authorization", "x-api-key", "api-key"]);

export function renderMarkdown(input: RenderInput): string {
  let reqJson: any = null;
  try {
    reqJson = JSON.parse(input.requestBody);
  } catch {
    // leave null; renderRequest falls back to raw
  }

  const model = reqJson?.model ?? "unknown";

  return (
    [
      renderMeta(input, model),
      renderHeaders(input.headers),
      "<request>\n\n" + renderRequest(input, reqJson) + "\n\n</request>",
      "<response>\n\n" + renderResponse(input, reqJson) + "\n\n</response>",
    ].join("\n\n") + "\n"
  );
}

function renderMeta(input: RenderInput, model: string): string {
  return [
    "<meta>",
    "",
    `- **timestamp**: ${input.timestamp}`,
    `- **provider**: ${input.provider}`,
    `- **model**: ${model}`,
    `- **endpoint**: ${input.method} ${input.path}`,
    `- **upstream status**: ${input.statusCode}`,
    "",
    "</meta>",
  ].join("\n");
}

function renderHeaders(headers: RenderInput["headers"]): string {
  const lines = Object.entries(headers).map(([key, value]) => {
    const shown = REDACT.has(key.toLowerCase())
      ? "[REDACTED]"
      : Array.isArray(value)
        ? value.join(", ")
        : (value ?? "");
    return `${key}: ${shown}`;
  });
  return ["<headers>", "", "```", ...lines, "```", "", "</headers>"].join("\n");
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function fenceJson(value: unknown): string {
  return "```json\n" + JSON.stringify(value, null, 2) + "\n```";
}

function fence(text: string, lang = ""): string {
  return "```" + lang + "\n" + text + "\n```";
}

/** Collapse a content field that may be a string or an array of text-ish blocks
 * down to plain text, preserving everything (only image base64 is placeheld). */
function blockText(block: any): string {
  if (typeof block === "string") return block;
  if (block?.type === "text" && typeof block.text === "string") return block.text;
  if (block?.type === "input_text" && typeof block.text === "string") return block.text;
  if (block?.type === "output_text" && typeof block.text === "string") return block.text;
  return "";
}

// ---------------------------------------------------------------------------
// Request rendering
// ---------------------------------------------------------------------------

function renderRequest(input: RenderInput, reqJson: any): string {
  if (reqJson == null) {
    return fence(input.requestBody);
  }
  try {
    if (input.provider === "anthropic") return renderAnthropicRequest(reqJson);
    return renderOpenAIRequest(reqJson);
  } catch (err) {
    return (
      `<!-- renderer error, showing raw JSON: ${(err as Error).message} -->\n\n` +
      fenceJson(reqJson)
    );
  }
}

function renderParams(reqJson: any, keys: string[]): string {
  const present = keys
    .filter((k) => reqJson[k] !== undefined)
    .map((k) => {
      const v = reqJson[k];
      const shown =
        typeof v === "object" ? JSON.stringify(v) : String(v);
      return `- **${k}**: ${shown}`;
    });
  if (present.length === 0) return "";
  return ["<params>", "", ...present, "", "</params>"].join("\n");
}

// ---- Anthropic --------------------------------------------------------------

function renderAnthropicRequest(j: any): string {
  const parts: string[] = [];

  const params = renderParams(j, [
    "max_tokens",
    "temperature",
    "top_p",
    "top_k",
    "stream",
    "stop_sequences",
    "tool_choice",
    "thinking",
    "metadata",
  ]);
  if (params) parts.push(params);

  if (j.system != null) {
    parts.push(
      ["<system-prompt>", "", renderAnthropicSystem(j.system), "", "</system-prompt>"].join(
        "\n"
      )
    );
  }

  if (Array.isArray(j.tools) && j.tools.length > 0) {
    parts.push(renderAnthropicTools(j.tools));
  }

  parts.push(renderMessages(j.messages, renderAnthropicContent));

  return parts.join("\n\n");
}

function renderAnthropicSystem(system: any): string {
  if (typeof system === "string") return system;
  if (Array.isArray(system)) {
    return system
      .map((block) => {
        const text = blockText(block);
        const marker = block?.cache_control
          ? "\n\n<!-- cache_control breakpoint -->"
          : "";
        return text + marker;
      })
      .join("\n\n");
  }
  return fenceJson(system);
}

function renderAnthropicTools(tools: any[]): string {
  const rendered = tools.map((tool) => {
    const lines = [`### ${tool.name ?? "(unnamed tool)"}`, ""];
    if (tool.description) lines.push(tool.description, "");
    if (tool.input_schema) lines.push(fenceJson(tool.input_schema));
    return lines.join("\n");
  });
  return ["<tools>", "", rendered.join("\n\n"), "", "</tools>"].join("\n");
}

function renderAnthropicContent(content: any): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return fenceJson(content);
  return content
    .map((block) => {
      switch (block?.type) {
        case "text":
          return block.text ?? "";
        case "tool_use":
          return [
            `<tool-use name="${block.name}" id="${block.id ?? ""}">`,
            "",
            fenceJson(block.input ?? {}),
            "",
            "</tool-use>",
          ].join("\n");
        case "tool_result": {
          const inner = renderToolResultContent(block.content);
          return [
            `<tool-result tool-use-id="${block.tool_use_id ?? ""}" is-error="${!!block.is_error}">`,
            "",
            inner,
            "",
            "</tool-result>",
          ].join("\n");
        }
        case "image":
          return imagePlaceholder(block);
        case "thinking":
          return [
            "<thinking>",
            "",
            block.thinking ?? "",
            "",
            "</thinking>",
          ].join("\n");
        default:
          return fenceJson(block);
      }
    })
    .join("\n\n");
}

function renderToolResultContent(content: any): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (b?.type === "image" ? imagePlaceholder(b) : blockText(b) || fenceJson(b)))
      .join("\n\n");
  }
  return fenceJson(content);
}

function imagePlaceholder(block: any): string {
  const src = block.source ?? {};
  const bytes = typeof src.data === "string" ? src.data.length : 0;
  return `\`[image: ${src.media_type ?? src.type ?? "unknown"}, ${bytes} base64 chars — full data in .request.txt]\``;
}

// ---- OpenAI -----------------------------------------------------------------

function renderOpenAIRequest(j: any): string {
  const parts: string[] = [];

  const params = renderParams(j, [
    "max_tokens",
    "max_output_tokens",
    "temperature",
    "top_p",
    "stream",
    "stop",
    "tool_choice",
    "reasoning",
    "metadata",
  ]);
  if (params) parts.push(params);

  // /responses uses `instructions` as the system prompt.
  if (typeof j.instructions === "string" && j.instructions.length > 0) {
    parts.push(
      ["<system-prompt>", "", j.instructions, "", "</system-prompt>"].join("\n")
    );
  }

  if (Array.isArray(j.tools) && j.tools.length > 0) {
    parts.push(renderOpenAITools(j.tools));
  }

  // /chat/completions => messages ; /responses => input (string or items)
  if (Array.isArray(j.messages)) {
    parts.push(renderMessages(j.messages, renderOpenAIChatContent));
  } else if (typeof j.input === "string") {
    parts.push(["<messages>", "", "<message role=\"user\">", "", j.input, "", "</message>", "", "</messages>"].join("\n"));
  } else if (Array.isArray(j.input)) {
    parts.push(renderMessages(j.input, renderOpenAIResponsesContent));
  }

  return parts.join("\n\n");
}

function renderOpenAITools(tools: any[]): string {
  const rendered = tools.map((tool) => {
    // chat: { type: "function", function: { name, description, parameters } }
    // responses: { type: "function", name, description, parameters }
    const fn = tool.function ?? tool;
    const lines = [`### ${fn.name ?? tool.type ?? "(unnamed tool)"}`, ""];
    if (fn.description) lines.push(fn.description, "");
    if (fn.parameters) lines.push(fenceJson(fn.parameters));
    return lines.join("\n");
  });
  return ["<tools>", "", rendered.join("\n\n"), "", "</tools>"].join("\n");
}

function renderOpenAIChatContent(msg: any): string {
  // In chat/completions each element IS the message {role, content, tool_calls}.
  const out: string[] = [];
  const content = msg.content;
  if (typeof content === "string") {
    out.push(content);
  } else if (Array.isArray(content)) {
    out.push(
      content
        .map((b) => (b?.type === "image_url" ? "`[image_url]`" : blockText(b) || fenceJson(b)))
        .join("\n\n")
    );
  }
  if (Array.isArray(msg.tool_calls)) {
    for (const call of msg.tool_calls) {
      const fn = call.function ?? {};
      out.push(
        [
          `<tool-use name="${fn.name}" id="${call.id ?? ""}">`,
          "",
          fence(fn.arguments ?? "", "json"),
          "",
          "</tool-use>",
        ].join("\n")
      );
    }
  }
  if (msg.role === "tool") {
    out.push(
      [
        `<tool-result tool-call-id="${msg.tool_call_id ?? ""}">`,
        "",
        typeof content === "string" ? content : fenceJson(content),
        "",
        "</tool-result>",
      ].join("\n")
    );
  }
  return out.join("\n\n");
}

function renderOpenAIResponsesContent(item: any): string {
  // /responses input items: message, function_call, function_call_output, ...
  switch (item?.type) {
    case "message":
    case undefined: {
      const content = item.content;
      if (typeof content === "string") return content;
      if (Array.isArray(content)) {
        return content.map((b) => blockText(b) || fenceJson(b)).join("\n\n");
      }
      return fenceJson(item);
    }
    case "function_call":
      return [
        `<tool-use name="${item.name}" id="${item.call_id ?? item.id ?? ""}">`,
        "",
        fence(item.arguments ?? "", "json"),
        "",
        "</tool-use>",
      ].join("\n");
    case "function_call_output":
      return [
        `<tool-result call-id="${item.call_id ?? ""}">`,
        "",
        typeof item.output === "string" ? item.output : fenceJson(item.output),
        "",
        "</tool-result>",
      ].join("\n");
    default:
      return fenceJson(item);
  }
}

// ---- shared message list ----------------------------------------------------

function renderMessages(
  messages: any[],
  renderContent: (msg: any) => string
): string {
  if (!Array.isArray(messages)) return "<messages></messages>";
  const rendered = messages.map((msg, i) => {
    const role = msg.role ?? msg.type ?? "unknown";
    // Anthropic: content lives on msg.content ; renderContent handles the shape.
    const inner =
      renderContent === renderAnthropicContent
        ? renderAnthropicContent(msg.content)
        : renderContent(msg);
    return [
      `<message index="${i + 1}" role="${role}">`,
      "",
      inner,
      "",
      "</message>",
    ].join("\n");
  });
  return ["<messages>", "", rendered.join("\n\n"), "", "</messages>"].join("\n");
}

// ---------------------------------------------------------------------------
// Response rendering (reassembled from the streamed SSE)
// ---------------------------------------------------------------------------

function renderResponse(input: RenderInput, reqJson: any): string {
  const raw = input.responseRaw;
  if (raw.trim().length === 0) return "_(empty response)_";

  const looksSSE = /(^|\n)\s*(event:|data:)/.test(raw);
  try {
    if (!looksSSE) {
      // Non-streaming JSON body.
      const parsed = JSON.parse(raw);
      return fenceJson(parsed);
    }
    if (input.provider === "anthropic") return renderAnthropicResponse(raw);
    return renderOpenAIResponse(raw, reqJson);
  } catch (err) {
    return (
      `<!-- response renderer error, showing raw stream: ${(err as Error).message} -->\n\n` +
      fence(raw)
    );
  }
}

/** Pull the JSON payloads out of `data: {...}` SSE lines. */
function sseData(raw: string): any[] {
  const out: any[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^data:\s?(.*)$/);
    if (!m) continue;
    const payload = m[1];
    if (payload === "[DONE]" || payload.trim() === "") continue;
    try {
      out.push(JSON.parse(payload));
    } catch {
      // skip un-parseable data lines
    }
  }
  return out;
}

function renderAnthropicResponse(raw: string): string {
  const events = sseData(raw);
  const blocks: Record<number, { type: string; text: string; name?: string; id?: string }> = {};
  let stopReason: string | undefined;
  let usage: any;

  for (const ev of events) {
    switch (ev.type) {
      case "content_block_start":
        blocks[ev.index] = {
          type: ev.content_block?.type ?? "text",
          text: "",
          name: ev.content_block?.name,
          id: ev.content_block?.id,
        };
        break;
      case "content_block_delta":
        if (blocks[ev.index]) {
          const d = ev.delta ?? {};
          blocks[ev.index].text += d.text ?? d.partial_json ?? d.thinking ?? "";
        }
        break;
      case "message_delta":
        if (ev.delta?.stop_reason) stopReason = ev.delta.stop_reason;
        if (ev.usage) usage = ev.usage;
        break;
      case "message_start":
        if (ev.message?.usage) usage = { ...ev.message.usage, ...(usage ?? {}) };
        break;
    }
  }

  const parts: string[] = [];
  if (stopReason) parts.push(`- **stop reason**: ${stopReason}`);
  if (usage) parts.push(`- **usage**: ${JSON.stringify(usage)}`);
  if (parts.length) parts.push("");

  const ordered = Object.keys(blocks)
    .map(Number)
    .sort((a, b) => a - b);
  for (const i of ordered) {
    const b = blocks[i];
    if (b.type === "text") {
      parts.push(["<assistant-text>", "", b.text, "", "</assistant-text>"].join("\n"));
    } else if (b.type === "thinking") {
      parts.push(["<thinking>", "", b.text, "", "</thinking>"].join("\n"));
    } else if (b.type === "tool_use") {
      parts.push(
        [
          `<tool-use name="${b.name}" id="${b.id ?? ""}">`,
          "",
          fence(b.text || "{}", "json"),
          "",
          "</tool-use>",
        ].join("\n")
      );
    }
  }
  if (ordered.length === 0 && parts.length === 0) return fence(raw);
  return parts.join("\n\n");
}

function renderOpenAIResponse(raw: string, reqJson: any): string {
  const events = sseData(raw);
  const isResponses = events.some(
    (e) => typeof e.type === "string" && e.type.startsWith("response.")
  );

  if (isResponses) return renderOpenAIResponsesStream(events);
  return renderOpenAIChatStream(events);
}

function renderOpenAIChatStream(events: any[]): string {
  let text = "";
  const toolCalls: Record<number, { name: string; args: string; id?: string }> = {};
  let finish: string | undefined;
  let usage: any;

  for (const ev of events) {
    const choice = ev.choices?.[0];
    const delta = choice?.delta ?? {};
    if (typeof delta.content === "string") text += delta.content;
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index ?? 0;
        toolCalls[idx] ??= { name: "", args: "", id: tc.id };
        if (tc.id) toolCalls[idx].id = tc.id;
        if (tc.function?.name) toolCalls[idx].name += tc.function.name;
        if (tc.function?.arguments) toolCalls[idx].args += tc.function.arguments;
      }
    }
    if (choice?.finish_reason) finish = choice.finish_reason;
    if (ev.usage) usage = ev.usage;
  }

  const parts: string[] = [];
  if (finish) parts.push(`- **finish reason**: ${finish}`);
  if (usage) parts.push(`- **usage**: ${JSON.stringify(usage)}`);
  if (parts.length) parts.push("");
  if (text) parts.push(["<assistant-text>", "", text, "", "</assistant-text>"].join("\n"));
  for (const idx of Object.keys(toolCalls).map(Number).sort((a, b) => a - b)) {
    const tc = toolCalls[idx];
    parts.push(
      [
        `<tool-use name="${tc.name}" id="${tc.id ?? ""}">`,
        "",
        fence(tc.args || "{}", "json"),
        "",
        "</tool-use>",
      ].join("\n")
    );
  }
  return parts.length ? parts.join("\n\n") : "_(no content decoded)_";
}

function renderOpenAIResponsesStream(events: any[]): string {
  let text = "";
  const toolCalls: Record<string, { name: string; args: string }> = {};
  let usage: any;
  let status: string | undefined;

  for (const ev of events) {
    switch (ev.type) {
      case "response.output_text.delta":
        text += ev.delta ?? "";
        break;
      case "response.function_call_arguments.delta": {
        const key = ev.item_id ?? "0";
        toolCalls[key] ??= { name: "", args: "" };
        toolCalls[key].args += ev.delta ?? "";
        break;
      }
      case "response.output_item.added":
        if (ev.item?.type === "function_call") {
          const key = ev.item.id ?? "0";
          toolCalls[key] ??= { name: "", args: "" };
          toolCalls[key].name = ev.item.name ?? toolCalls[key].name;
        }
        break;
      case "response.completed":
        status = ev.response?.status;
        usage = ev.response?.usage ?? usage;
        break;
    }
  }

  const parts: string[] = [];
  if (status) parts.push(`- **status**: ${status}`);
  if (usage) parts.push(`- **usage**: ${JSON.stringify(usage)}`);
  if (parts.length) parts.push("");
  if (text) parts.push(["<assistant-text>", "", text, "", "</assistant-text>"].join("\n"));
  for (const key of Object.keys(toolCalls)) {
    const tc = toolCalls[key];
    parts.push(
      [
        `<tool-use name="${tc.name}" id="${key}">`,
        "",
        fence(tc.args || "{}", "json"),
        "",
        "</tool-use>",
      ].join("\n")
    );
  }
  return parts.length ? parts.join("\n\n") : "_(no content decoded)_";
}
