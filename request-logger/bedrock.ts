/**
 * Bedrock's streaming wire format, decoded for the capture only.
 *
 * Every other provider in this tool streams Server-Sent Events, so the response
 * bytes are already text and render.ts can read them directly. Bedrock's
 * `invoke-with-response-stream` does not: it returns AWS's binary
 * `vnd.amazon.eventstream` framing, and each frame's payload is a JSON envelope
 * whose `bytes` field is the base64 of the Anthropic SSE event inside. Left
 * alone, that reaches the capture as a page of replacement characters — the
 * proxy stringifies the response as UTF-8, which is lossy for binary, so it
 * cannot even be recovered later from the .md.
 *
 * Decoding it here, into the `event:`/`data:` text the same events would have had
 * coming straight from Anthropic, means renderAnthropicResponse reassembles a
 * Bedrock response exactly as it does a direct one, with no renderer of its own.
 * The bytes forwarded to the agent are never touched — only the copy written to
 * disk. This is the same split the request side already makes for a
 * zstd-compressed body (see decodeBody in render.ts).
 */

/** The content type Bedrock's streaming endpoint answers with. */
export const EVENT_STREAM_CONTENT_TYPE = "application/vnd.amazon.eventstream";

export function isEventStream(contentType: string | string[] | undefined): boolean {
  const value = Array.isArray(contentType) ? contentType[0] : contentType;
  return typeof value === "string" && value.includes(EVENT_STREAM_CONTENT_TYPE);
}

/** Bytes before the headers in every frame: two lengths and the prelude CRC. */
const PRELUDE_BYTES = 12;
/** The prelude plus the trailing message CRC. */
const FRAME_OVERHEAD_BYTES = PRELUDE_BYTES + 4;

export interface EventStreamMessage {
  headers: Record<string, string>;
  payload: Buffer;
}

/**
 * Split the stream into messages.
 *
 * A truncated trailing frame is dropped rather than throwing: a stream can be cut
 * off mid-frame when a request is cancelled, and a capture of a cancelled request
 * is still worth reading up to the point it stopped.
 */
export function parseEventStream(raw: Buffer): EventStreamMessage[] {
  const messages: EventStreamMessage[] = [];
  let offset = 0;

  while (offset + PRELUDE_BYTES <= raw.length) {
    const totalLength = raw.readUInt32BE(offset);
    const headersLength = raw.readUInt32BE(offset + 4);

    // A frame must at least hold its own overhead and headers, and must fit in
    // what is left. Anything else means the framing is not what we think it is,
    // so stop rather than walk off into the middle of a payload.
    if (
      totalLength < FRAME_OVERHEAD_BYTES + headersLength ||
      offset + totalLength > raw.length
    ) {
      break;
    }

    const headersStart = offset + PRELUDE_BYTES;
    const payloadStart = headersStart + headersLength;
    const payloadEnd = offset + totalLength - 4; // less the message CRC

    messages.push({
      headers: parseHeaders(raw.subarray(headersStart, payloadStart)),
      payload: raw.subarray(payloadStart, payloadEnd),
    });

    offset += totalLength;
  }

  return messages;
}

/**
 * Read a frame's headers.
 *
 * Only string headers carry anything this tool shows (`:event-type`,
 * `:exception-type`, `:message-type`), but every value type still has to be
 * walked past to find where the next header begins, which is why the numeric
 * and boolean types are here as widths rather than as values.
 */
function parseHeaders(buf: Buffer): Record<string, string> {
  const headers: Record<string, string> = {};
  let offset = 0;

  while (offset < buf.length) {
    const nameLength = buf.readUInt8(offset);
    offset += 1;
    const name = buf.subarray(offset, offset + nameLength).toString("utf8");
    offset += nameLength;
    const type = buf.readUInt8(offset);
    offset += 1;

    switch (type) {
      case 0: // boolean true
      case 1: // boolean false
        headers[name] = String(type === 0);
        break;
      case 2: // byte
        offset += 1;
        break;
      case 3: // short
        offset += 2;
        break;
      case 4: // integer
        offset += 4;
        break;
      case 5: // long
      case 8: // timestamp
        offset += 8;
        break;
      case 6: // byte array
      case 7: {
        // string
        const length = buf.readUInt16BE(offset);
        offset += 2;
        if (type === 7) {
          headers[name] = buf.subarray(offset, offset + length).toString("utf8");
        }
        offset += length;
        break;
      }
      case 9: // uuid
        offset += 16;
        break;
      default:
        // An unknown type has an unknown width, so the rest of this header
        // block cannot be walked. Return what was read.
        return headers;
    }
  }

  return headers;
}

/**
 * Turn a Bedrock event stream into the SSE text the same events have on the
 * direct Anthropic API, so render.ts reads both with one renderer.
 *
 * A frame whose payload is not the expected `{"bytes": "<base64>"}` envelope is
 * emitted as-is under an `event:` line naming what it was. That covers Bedrock's
 * modelStreamErrorException and friends, which is exactly the case where the
 * student most needs to see the body rather than have it dropped for not
 * matching the happy path.
 */
export function eventStreamToSse(raw: Buffer): string {
  const out: string[] = [];

  for (const message of parseEventStream(raw)) {
    const eventType =
      message.headers[":event-type"] ??
      message.headers[":exception-type"] ??
      message.headers[":message-type"] ??
      "message";

    const text = message.payload.toString("utf8");
    let inner: string | null = null;
    try {
      const envelope = JSON.parse(text);
      if (typeof envelope?.bytes === "string") {
        inner = Buffer.from(envelope.bytes, "base64").toString("utf8");
      }
    } catch {
      // Not JSON — fall through and show the payload as it arrived.
    }

    if (inner === null) {
      out.push(`event: ${eventType}\ndata: ${text}\n`);
      continue;
    }

    // The Anthropic event's own `type` is the accurate SSE event name; the
    // frame's `:event-type` is always the generic "chunk" here.
    let name = eventType;
    try {
      const parsed = JSON.parse(inner);
      if (typeof parsed?.type === "string") name = parsed.type;
    } catch {
      // Keep the frame's event type when the inner payload is not JSON.
    }
    out.push(`event: ${name}\ndata: ${inner}\n`);
  }

  return out.join("\n");
}
