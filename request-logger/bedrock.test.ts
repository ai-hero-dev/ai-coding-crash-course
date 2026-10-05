import { describe, expect, it } from "vitest";
import {
  eventStreamToSse,
  isEventStream,
  parseEventStream,
  EVENT_STREAM_CONTENT_TYPE,
} from "./bedrock";

/**
 * Build one `vnd.amazon.eventstream` frame, so the fixtures below are real
 * framing rather than a guess at it. The CRCs are left as zeroes: the decoder
 * skips over them by design, because a capture of a stream that was cut off is
 * still worth reading, and verifying them would only make a truncated stream
 * throw instead.
 */
function frame(headers: Record<string, string>, payload: string): Buffer {
  const headerParts: Buffer[] = [];
  for (const [name, value] of Object.entries(headers)) {
    const nameBytes = Buffer.from(name, "utf8");
    const valueBytes = Buffer.from(value, "utf8");
    const head = Buffer.alloc(2 + nameBytes.length);
    head.writeUInt8(nameBytes.length, 0);
    nameBytes.copy(head, 1);
    head.writeUInt8(7, 1 + nameBytes.length); // 7 = string
    const length = Buffer.alloc(2);
    length.writeUInt16BE(valueBytes.length, 0);
    headerParts.push(Buffer.concat([head, length, valueBytes]));
  }

  const headerBytes = Buffer.concat(headerParts);
  const payloadBytes = Buffer.from(payload, "utf8");
  const totalLength = 16 + headerBytes.length + payloadBytes.length;

  const prelude = Buffer.alloc(12);
  prelude.writeUInt32BE(totalLength, 0);
  prelude.writeUInt32BE(headerBytes.length, 4);

  return Buffer.concat([prelude, headerBytes, payloadBytes, Buffer.alloc(4)]);
}

/** The envelope Bedrock wraps each Anthropic SSE event in. */
function chunk(event: unknown): Buffer {
  return frame(
    { ":event-type": "chunk", ":content-type": "application/json" },
    JSON.stringify({ bytes: Buffer.from(JSON.stringify(event), "utf8").toString("base64") })
  );
}

describe("isEventStream", () => {
  it("recognises Bedrock's streaming content type", () => {
    expect(isEventStream(EVENT_STREAM_CONTENT_TYPE)).toBe(true);
  });

  it.each([
    ["SSE", "text/event-stream"],
    ["plain JSON", "application/json"],
    ["absent", undefined],
  ])("leaves a %s response alone", (_name, contentType) => {
    expect(isEventStream(contentType)).toBe(false);
  });
});

describe("parseEventStream", () => {
  it("reads a frame's string headers and payload", () => {
    const [message] = parseEventStream(frame({ ":event-type": "chunk" }, "hello"));
    expect(message.headers).toEqual({ ":event-type": "chunk" });
    expect(message.payload.toString("utf8")).toBe("hello");
  });

  it("walks past every header value type to find the payload", () => {
    // A frame whose headers include the fixed-width types the decoder only
    // needs to step over. Hand-built, since the helper above writes strings.
    const headerBytes = Buffer.concat([
      Buffer.from([1, 0x61, 4]), // "a": integer
      Buffer.from([0, 0, 0, 7]),
      Buffer.from([1, 0x62, 8]), // "b": timestamp
      Buffer.alloc(8),
      Buffer.from([1, 0x63, 0]), // "c": boolean true
      Buffer.from([1, 0x64, 7]), // "d": string
      Buffer.from([0, 2]),
      Buffer.from("hi", "utf8"),
    ]);
    const payload = Buffer.from("body", "utf8");
    const prelude = Buffer.alloc(12);
    prelude.writeUInt32BE(16 + headerBytes.length + payload.length, 0);
    prelude.writeUInt32BE(headerBytes.length, 4);
    const raw = Buffer.concat([prelude, headerBytes, payload, Buffer.alloc(4)]);

    const [message] = parseEventStream(raw);
    expect(message.headers).toEqual({ c: "true", d: "hi" });
    expect(message.payload.toString("utf8")).toBe("body");
  });

  it("reads every frame in a multi-frame stream", () => {
    const raw = Buffer.concat([
      frame({ ":event-type": "chunk" }, "one"),
      frame({ ":event-type": "chunk" }, "two"),
      frame({ ":event-type": "chunk" }, "three"),
    ]);
    expect(parseEventStream(raw).map((m) => m.payload.toString("utf8"))).toEqual([
      "one",
      "two",
      "three",
    ]);
  });

  it("keeps the complete frames of a stream cut off mid-frame", () => {
    const complete = frame({ ":event-type": "chunk" }, "kept");
    const raw = Buffer.concat([complete, frame({ ":event-type": "chunk" }, "lost").subarray(0, 20)]);
    expect(parseEventStream(raw).map((m) => m.payload.toString("utf8"))).toEqual(["kept"]);
  });

  it("has nothing to read in an empty response", () => {
    expect(parseEventStream(Buffer.alloc(0))).toEqual([]);
  });
});

describe("eventStreamToSse", () => {
  it("unwraps the base64 envelope into the SSE the Anthropic API sends", () => {
    const raw = Buffer.concat([
      chunk({ type: "message_start", message: { id: "msg_1" } }),
      chunk({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } }),
      chunk({ type: "message_stop" }),
    ]);

    expect(eventStreamToSse(raw)).toBe(
      [
        `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "msg_1" } })}\n`,
        `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } })}\n`,
        `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n`,
      ].join("\n")
    );
  });

  it("produces text the response renderer recognises as SSE", () => {
    // renderResponse in render.ts decides a body is SSE with this test, so a
    // decode that did not satisfy it would render as a raw dump instead.
    const sse = eventStreamToSse(chunk({ type: "message_stop" }));
    expect(/(^|\n)\s*(event:|data:)/.test(sse)).toBe(true);
  });

  it("names the event after the Anthropic type, not the generic frame type", () => {
    // Every Bedrock frame is ":event-type: chunk", which would make an entire
    // capture look like one repeated event.
    expect(eventStreamToSse(chunk({ type: "content_block_start", index: 0 }))).toContain(
      "event: content_block_start"
    );
  });

  it("shows a Bedrock exception frame's body rather than dropping it", () => {
    const raw = frame(
      { ":exception-type": "modelStreamErrorException", ":message-type": "exception" },
      JSON.stringify({ message: "model stream failed" })
    );
    const sse = eventStreamToSse(raw);
    expect(sse).toContain("event: modelStreamErrorException");
    expect(sse).toContain("model stream failed");
  });

  it("shows a payload that is not the expected envelope as it arrived", () => {
    const sse = eventStreamToSse(frame({ ":event-type": "chunk" }, "not json"));
    expect(sse).toBe("event: chunk\ndata: not json\n");
  });

  it("has nothing to show for an empty response", () => {
    expect(eventStreamToSse(Buffer.alloc(0))).toBe("");
  });
});
