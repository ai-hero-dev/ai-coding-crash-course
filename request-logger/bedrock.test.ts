import zlib from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  authorizationFor,
  canonicalQuery,
  canonicalUri,
  crc32,
  createCredentialProvider,
  decodeBedrockStream,
  parseEventStream,
  signRequest,
  signingKey,
  uriEncode,
} from "./bedrock";
import {
  bedrockChunk,
  bedrockException,
  eventStreamMessage,
} from "./e2e/fake-upstream";

const SECRET = "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY";
const EMPTY_SHA256 =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

describe("SigV4 against AWS's published values", () => {
  it("derives the signing key from AWS's documented example", () => {
    expect(
      signingKey(SECRET, "20150830", "us-east-1", "iam").toString("hex")
    ).toBe("c4afb1cc5771d871763a393e44b703571b55cc28424d1a5e86da6ed3c154a4b9");
  });

  it("matches the signature in AWS's get-vanilla test vector", () => {
    const auth = authorizationFor({
      method: "GET",
      path: "/",
      headers: {
        host: "example.amazonaws.com",
        "x-amz-date": "20150830T123600Z",
      },
      payloadHash: EMPTY_SHA256,
      amzDate: "20150830T123600Z",
      region: "us-east-1",
      service: "service",
      credentials: { accessKeyId: "AKIDEXAMPLE", secretAccessKey: SECRET },
    });
    expect(auth).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, " +
        "SignedHeaders=host;x-amz-date, " +
        "Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31"
    );
  });

  it("encodes the way RFC 3986 asks", () => {
    expect(uriEncode("a b/c:d!*'()")).toBe("a%20b%2Fc%3Ad%21%2A%27%28%29");
    expect(uriEncode("A-z_0.9~")).toBe("A-z_0.9~");
  });

  it("encodes each path segment a second time, as every service but S3 requires", () => {
    expect(canonicalUri("/model/x-v1%3A0/invoke")).toBe("/model/x-v1%253A0/invoke");
    expect(canonicalUri("")).toBe("/");
  });

  it("sorts the query by name, then value, not by the joined text", () => {
    expect(canonicalQuery("a-b=2&a=1")).toBe("a=1&a-b=2");
    expect(canonicalQuery("a=2&a=1&B=3")).toBe("B=3&a=1&a=2");
    expect(canonicalQuery("")).toBe("");
  });
});

describe("signRequest", () => {
  const base = {
    method: "POST",
    hostname: "bedrock-runtime.us-east-1.amazonaws.com",
    path: "/model/us.anthropic.claude-haiku-4-5-20251001-v1%3A0/invoke-with-response-stream",
    body: Buffer.from('{"a":1}'),
    region: "us-east-1",
    service: "bedrock",
    now: new Date("2026-11-28T10:00:00.000Z"),
  };

  it("signs host, content hash, date and the session token", () => {
    const out = signRequest({
      ...base,
      credentials: {
        accessKeyId: "AKID",
        secretAccessKey: "SECRET",
        sessionToken: "TOKEN",
      },
    });
    expect(out["x-amz-date"]).toBe("20261128T100000Z");
    expect(out["x-amz-security-token"]).toBe("TOKEN");
    expect(out.authorization).toContain(
      "SignedHeaders=host;x-amz-content-sha256;x-amz-date;x-amz-security-token"
    );
    expect(out.authorization).toContain(
      "Credential=AKID/20261128/us-east-1/bedrock/aws4_request"
    );
    expect(JSON.stringify(out)).not.toContain("SECRET");
  });

  it("omits the token header for long-lived keys", () => {
    const out = signRequest({
      ...base,
      credentials: { accessKeyId: "AKID", secretAccessKey: "SECRET" },
    });
    expect(out).not.toHaveProperty("x-amz-security-token");
    expect(out.authorization).toContain(
      "SignedHeaders=host;x-amz-content-sha256;x-amz-date,"
    );
  });

  it("gives a different signature for a different body", () => {
    const credentials = { accessKeyId: "AKID", secretAccessKey: "SECRET" };
    const a = signRequest({ ...base, credentials });
    const b = signRequest({ ...base, body: Buffer.from("{}"), credentials });
    expect(a.authorization).not.toBe(b.authorization);
  });
});

describe("createCredentialProvider", () => {
  const cliOutput = (expiration?: string) =>
    JSON.stringify({
      Version: 1,
      AccessKeyId: "AKID",
      SecretAccessKey: "SECRET",
      SessionToken: "TOKEN",
      Expiration: expiration,
    });

  it("uses env keys without calling the AWS CLI", async () => {
    let calls = 0;
    const provider = createCredentialProvider(
      { AWS_ACCESS_KEY_ID: "A", AWS_SECRET_ACCESS_KEY: "S" },
      async () => {
        calls++;
        return "";
      }
    );
    expect((await provider.get()).accessKeyId).toBe("A");
    expect(calls).toBe(0);
  });

  it("caches CLI credentials until shortly before they expire", async () => {
    let calls = 0;
    let now = Date.parse("2026-11-28T10:00:00Z");
    const provider = createCredentialProvider(
      {},
      async () => {
        calls++;
        return cliOutput("2026-11-28T11:00:00Z");
      },
      () => now
    );
    await provider.get();
    await provider.get();
    expect(calls).toBe(1);
    now = Date.parse("2026-11-28T10:58:30Z"); // inside the 2 minute margin
    await provider.get();
    expect(calls).toBe(2);
  });

  it("reloads after invalidate()", async () => {
    let calls = 0;
    const provider = createCredentialProvider({}, async () => {
      calls++;
      return cliOutput("2099-01-01T00:00:00Z");
    });
    await provider.get();
    provider.invalidate();
    await provider.get();
    expect(calls).toBe(2);
  });

  it("shares one CLI call between simultaneous requests", async () => {
    let calls = 0;
    const provider = createCredentialProvider({}, async () => {
      calls++;
      return cliOutput();
    });
    await Promise.all([provider.get(), provider.get(), provider.get()]);
    expect(calls).toBe(1);
  });

  it("tells the student to run aws sso login when the CLI fails", async () => {
    const provider = createCredentialProvider(
      { AWS_PROFILE: "work" },
      async () => {
        throw new Error("Token has expired");
      }
    );
    await expect(provider.get()).rejects.toThrow(/profile "work".*aws sso login/s);
  });
});

describe("crc32", () => {
  it("gives the standard check value, and agrees with zlib", () => {
    expect(crc32(Buffer.from("123456789"))).toBe(0xcbf43926);
    const bytes = Buffer.from("any bytes at all, é included");
    expect(crc32(bytes)).toBe(zlib.crc32(bytes));
  });
});

describe("parseEventStream", () => {
  it("reads each message's string headers and payload", () => {
    const parsed = parseEventStream(
      Buffer.concat([
        eventStreamMessage({ ":message-type": "event", a: "1" }, "first"),
        eventStreamMessage({ ":message-type": "event" }, ""),
      ])
    );
    expect(parsed?.truncated).toBe(false);
    expect(
      parsed?.messages.map((m) => [m.headers, m.payload.toString()])
    ).toEqual([
      [{ ":message-type": "event", a: "1" }, "first"],
      [{ ":message-type": "event" }, ""],
    ]);
  });

  it("is not fooled by SSE, JSON or an empty body", () => {
    expect(parseEventStream(Buffer.from("event: ping\ndata: {}\n\n"))).toBeUndefined();
    expect(parseEventStream(Buffer.from('{"message":"nope"}'))).toBeUndefined();
    expect(parseEventStream(Buffer.alloc(0))).toBeUndefined();
  });

  it("stops at a corrupted message and says the rest did not decode", () => {
    const good = eventStreamMessage({ ":message-type": "event" }, "ok");
    const bad = eventStreamMessage({ ":message-type": "event" }, "flipped");
    bad[bad.length - 6] ^= 0xff; // one payload byte, so the message CRC fails
    const parsed = parseEventStream(Buffer.concat([good, bad]));
    expect(parsed?.messages).toHaveLength(1);
    expect(parsed?.truncated).toBe(true);
  });

  it("notices a stream cut off part-way through a message", () => {
    const whole = eventStreamMessage({ ":message-type": "event" }, "ok");
    const parsed = parseEventStream(
      Buffer.concat([whole, whole.subarray(0, whole.length - 3)])
    );
    expect(parsed?.messages).toHaveLength(1);
    expect(parsed?.truncated).toBe(true);
  });
});

describe("decodeBedrockStream", () => {
  it("rebuilds the Anthropic SSE events from the base64 chunks", () => {
    const out = decodeBedrockStream(
      Buffer.concat([
        bedrockChunk({ type: "message_start" }),
        bedrockChunk({ type: "content_block_delta", delta: { text: "hi" } }),
      ])
    );
    expect(out?.sse).toBe(
      'event: message_start\ndata: {"type":"message_start"}\n\n' +
        'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"text":"hi"}}\n'
    );
    expect(out?.errors).toEqual([]);
  });

  it("names the exception Bedrock sends part-way through a stream", () => {
    const out = decodeBedrockStream(
      Buffer.concat([
        bedrockChunk({ type: "message_start" }),
        bedrockException("throttlingException", 'Too many "tokens"'),
      ])
    );
    expect(out?.errors).toEqual(['throttlingException: Too many "tokens"']);
  });

  it("reports a stream that was cut off", () => {
    const chunk = bedrockChunk({ type: "message_start" });
    const out = decodeBedrockStream(Buffer.concat([chunk, chunk.subarray(0, 20)]));
    expect(out?.errors).toEqual(["the stream ended part-way through a message"]);
  });

  it("leaves a plain SSE or JSON response alone", () => {
    expect(decodeBedrockStream(Buffer.from("event: ping\ndata: {}\n"))).toBeUndefined();
    expect(decodeBedrockStream(Buffer.from('{"message":"nope"}'))).toBeUndefined();
  });
});
