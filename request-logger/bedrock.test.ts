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

  const STS_TOKEN =
    "AQoDYXdzEPT//////////wEXAMPLEtc764bNrC9SAPBSM22wDOk4x4HIZ8j4FZTwdQWLWsKWHGBuFqwAeMicRXmxfpSPfIeoIYRqTflfKD8YUuwthAx7mSEI/qkPpKPi/kMcGdQrmGdeehM4IC1NtBmUpp2wUE8phUZampKsburEDy0KPkyQDYwT7WZ0wq5VSXDvp75YU9HFvlRd8Tx6q6fE8YQcHNVXAkiY9q6d+xo0rKwT38xVqr7ZD0u0iPPkUL64lIZbqBAz+scqKmlzm8FDrypNC9Yjc8fPOLn9FX9KSYvKTr4rvx3iSIlTJabIQwj2ICCR/oLxBA==";
  const FORM_SHA256 = "9095672bbd1f56dfc5b65f3e153adc8731a4a654192329106275f4c7b24d0b6e";

  it.each([
    ["post-vanilla", "POST", "/", {}, EMPTY_SHA256, "5da7c1a2acd57cee7505fc6676e4e544621c30862966e37dddb68e92efbe5d6b"],
    [
      "post-x-www-form-urlencoded",
      "POST",
      "/",
      {
        "content-length": "13",
        "content-type": "application/x-www-form-urlencoded",
        "x-amz-content-sha256": FORM_SHA256,
      },
      FORM_SHA256,
      "d3875051da38690788ef43de4db0d8f280229d82040bfac253562e56c3f20e0b",
    ],
    [
      "get-vanilla-with-session-token",
      "GET",
      "/",
      { "x-amz-security-token": "6e86291e8372ff2a2260956d9b8aae1d763fbf315fa00fa31553b73ebf194267" },
      EMPTY_SHA256,
      "07ec1639c89043aa0e3e2de82b96708f198cceab042d4a97044c66dd9f74e7f8",
    ],
    ["post-sts-header-before", "POST", "/", { "x-amz-security-token": STS_TOKEN }, EMPTY_SHA256, "85d96828115b5dc0cfc3bd16ad9e210dd772bbebba041836c64533a82be05ead"],
    ["get-space-unnormalized", "GET", "/example space/", {}, EMPTY_SHA256, "652487583200325589f1fba4c7e578f72c47cb61beeca81406b39ddec1366741"],
    ["get-utf8", "GET", "/\u1234", {}, EMPTY_SHA256, "8318018e0b0f223aa2bbf98705b62bb787dc9c0e678f255a891fd03141be5d85"],
    ["get-vanilla-query-order-encoded", "GET", "/?Param-3=Value3&Param=Value2&%E1%88%B4=Value1", {}, EMPTY_SHA256, "371d3713e185cc334048618a97f809c9ffe339c62934c032af5a0e595648fcac"],
    ["get-vanilla-utf8-query", "GET", "/?\u1234=bar", {}, EMPTY_SHA256, "2cdec8eed098649ff3a119c94853b13c643bcf08f8b0a1d91e12c9027818dd04"],
  ] as const)("matches AWS's %s test vector", (_name, method, path, extra, payloadHash, signature) => {
    const auth = authorizationFor({
      method,
      path,
      headers: { host: "example.amazonaws.com", "x-amz-date": "20150830T123600Z", ...extra },
      payloadHash,
      amzDate: "20150830T123600Z",
      region: "us-east-1",
      service: "service",
      credentials: { accessKeyId: "AKIDEXAMPLE", secretAccessKey: SECRET },
    });
    expect(auth.slice(auth.indexOf("Signature=") + 10)).toBe(signature);
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

  it("keeps a + in the query as a +, the way the AWS SDKs sign it", () => {
    expect(canonicalQuery("a=b+c&d=e%2Bf")).toBe("a=b%2Bc&d=e%2Bf");
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

  it("reloads after AWS rejects the credentials it handed out", async () => {
    let calls = 0;
    let now = 0;
    const provider = createCredentialProvider(
      {},
      async () => {
        calls++;
        return cliOutput("2099-01-01T00:00:00Z");
      },
      () => now
    );
    const rejected = await provider.get();
    now = 30_000;
    provider.invalidate(rejected);
    await provider.get();
    expect(calls).toBe(2);
  });

  it("keeps credentials that are nearly expired for 30 seconds, not zero", async () => {
    let calls = 0;
    let now = Date.parse("2026-11-28T10:00:00Z");
    const provider = createCredentialProvider(
      {},
      async () => {
        calls++;
        return cliOutput("2026-11-28T10:01:30Z");
      },
      () => now
    );
    for (let i = 0; i < 5; i++) {
      await provider.get();
      now += 1_000;
    }
    expect(calls).toBe(1);
    now += 30_000;
    await provider.get();
    expect(calls).toBe(2);
  });

  it("runs the AWS CLI at most once every 30 seconds however many 403s come back", async () => {
    let calls = 0;
    let now = 0;
    const provider = createCredentialProvider(
      {},
      async () => {
        calls++;
        return cliOutput("2099-01-01T00:00:00Z");
      },
      () => now
    );
    for (let i = 0; i < 5; i++) {
      provider.invalidate(await provider.get());
      now += 1_000;
    }
    expect(calls).toBe(1);
  });

  it("ignores a rejection of credentials it has already replaced", async () => {
    let calls = 0;
    let now = 0;
    const provider = createCredentialProvider(
      {},
      async () => {
        calls++;
        return cliOutput("2099-01-01T00:00:00Z");
      },
      () => now
    );
    const first = await provider.get();
    now = 60_000;
    provider.invalidate(first);
    const second = await provider.get();
    provider.invalidate(first);
    expect(await provider.get()).toBe(second);
    expect(calls).toBe(2);
  });

  it("does not lose a newer load to a rejection that arrives while it runs", async () => {
    let release: (out: string) => void = () => {};
    let calls = 0;
    const provider = createCredentialProvider({}, () => {
      calls++;
      return new Promise((resolve) => (release = resolve));
    });
    const loading = provider.get();
    provider.invalidate({ accessKeyId: "OLDER", secretAccessKey: "s" });
    release(cliOutput("2099-01-01T00:00:00Z"));
    await loading;
    await provider.get();
    expect(calls).toBe(1);
  });

  it("never quotes the AWS CLI's output in its error, which could hold a secret", async () => {
    for (const out of [
      '{"AccessKeyId":"AKID","SecretAccessKey":LEAKED-SECRET}',
      "LEAKED-SECRET",
    ]) {
      const provider = createCredentialProvider({}, async () => out);
      const error = await provider.get().catch((e: Error) => e);
      expect((error as Error).message).toContain("not JSON");
      expect((error as Error).message).not.toContain("LEAKED");
    }
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
    expect(parsed?.stopped).toBeNull();
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
    expect(parsed?.stopped).toBe("corrupt");
  });

  it("notices a stream cut off part-way through a message", () => {
    const whole = eventStreamMessage({ ":message-type": "event" }, "ok");
    const parsed = parseEventStream(
      Buffer.concat([whole, whole.subarray(0, whole.length - 3)])
    );
    expect(parsed?.messages).toHaveLength(1);
    expect(parsed?.stopped).toBe("cut-off");
  });

  it("calls a message corrupt when its CRCs pass but its headers run past the end", () => {
    const headers = Buffer.from([1, 0x61, 7]);
    const prelude = Buffer.alloc(12);
    prelude.writeUInt32BE(12 + headers.length + 4, 0);
    prelude.writeUInt32BE(headers.length, 4);
    prelude.writeUInt32BE(zlib.crc32(prelude.subarray(0, 8)), 8);
    const message = Buffer.concat([prelude, headers]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(message), 0);
    const good = eventStreamMessage({ ":message-type": "event" }, "ok");
    expect(parseEventStream(Buffer.concat([good, message, crc]))?.stopped).toBe("corrupt");
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

  it("gives a chunk with no type a data line only", () => {
    expect(decodeBedrockStream(bedrockChunk({ foo: 1 }))?.sse).toBe('data: {"foo":1}\n');
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

  it("tells a corrupted message apart from a cut-off stream", () => {
    const chunk = bedrockChunk({ type: "message_start" });
    const bad = Buffer.from(chunk);
    bad[bad.length - 6] ^= 0xff;
    expect(decodeBedrockStream(Buffer.concat([chunk, bad]))?.errors).toEqual([
      "a message failed its CRC or header check, so the rest of the stream was not decoded",
    ]);
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
