import { describe, expect, it, vi } from "vitest";
import { bedrockUpstream, resolveChoice, type ResolvedTarget } from "./agents";
import { signedHeaders } from "./proxy";
import { renderMarkdown } from "./render";
import {
  canonicalUri,
  createCredentialProvider,
  signRequest,
  uriEncode,
} from "./sigv4";

function bedrock(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = "darwin") {
  return resolveChoice(
    { agent: "claude-code", provider: "bedrock" },
    { port: 8787, platform, env }
  );
}

describe("Claude Code on Amazon Bedrock", () => {
  it("forwards to bedrock-runtime in the AWS_REGION of the shell", () => {
    const t = bedrock({ AWS_REGION: "eu-west-1" }) as ResolvedTarget;
    expect(t.kind).toBe("target");
    expect(t.upstreamHost).toBe("bedrock-runtime.eu-west-1.amazonaws.com");
    expect(t.awsSigning).toEqual({ region: "eu-west-1", service: "bedrock" });
    expect(t.renderer).toBe("anthropic");
    expect(t.baseUrl).toBe("http://localhost:8787");
  });

  it("falls back to AWS_DEFAULT_REGION", () => {
    const t = bedrock({ AWS_DEFAULT_REGION: "us-west-2" }) as ResolvedTarget;
    expect(t.upstreamHost).toBe("bedrock-runtime.us-west-2.amazonaws.com");
  });

  it("refuses to start without a region, rather than guessing one", () => {
    const r = bedrock({});
    expect(r.kind).toBe("error");
    expect(r.kind === "error" && r.message).toContain("AWS_REGION");
  });

  it("rejects a region that could not be part of a host name", () => {
    expect(bedrockUpstream({ agent: "claude-code" }, { AWS_REGION: "evil.com/x" })).toHaveProperty("error");
  });

  it("sets the Bedrock base URL and skips Claude Code's own signing", () => {
    const t = bedrock({ AWS_REGION: "us-east-1" }) as ResolvedTarget;
    expect(t.command).toBe(
      "ANTHROPIC_BEDROCK_BASE_URL=http://localhost:8787 CLAUDE_CODE_SKIP_BEDROCK_AUTH=1 ENABLE_TOOL_SEARCH=true claude"
    );
    expect(t.command).not.toContain("ANTHROPIC_BASE_URL=");
  });

  it("uses PowerShell $env: syntax on Windows", () => {
    const t = bedrock({ AWS_REGION: "us-east-1" }, "win32") as ResolvedTarget;
    expect(t.command).toContain("$env:ANTHROPIC_BEDROCK_BASE_URL = 'http://localhost:8787'");
    expect(t.command).toContain("$env:CLAUDE_CODE_SKIP_BEDROCK_AUTH = '1'");
  });

  it("points an API-key user at the API-key route", () => {
    const t = bedrock({ AWS_REGION: "us-east-1", AWS_BEARER_TOKEN_BEDROCK: "k" }) as ResolvedTarget;
    expect(t.notes.join(" ")).toContain("pick Amazon Bedrock (API key)");
  });

  it("names the profile it will sign with", () => {
    const t = bedrock({ AWS_REGION: "us-east-1", AWS_PROFILE: "AI" }) as ResolvedTarget;
    expect(t.notes.join(" ")).toContain('AWS profile "AI"');
  });
});

describe("SigV4", () => {
  const credentials = {
    accessKeyId: "AKIDTEST",
    secretAccessKey: "test-secret",
  };
  const base = {
    method: "POST",
    hostname: "bedrock-runtime.us-east-1.amazonaws.com",
    path: "/model/us.anthropic.claude-haiku-4-5-20251001-v1%3A0/invoke-with-response-stream",
    body: Buffer.from('{"messages":[]}'),
    region: "us-east-1",
    service: "bedrock",
    credentials,
    now: new Date("2026-01-02T03:04:05.678Z"),
  };

  it("encodes everything but unreserved characters", () => {
    expect(uriEncode("a b:c*()!'~._-")).toBe("a%20b%3Ac%2A%28%29%21%27~._-");
  });

  it("encodes each path segment a second time, as non-S3 services require", () => {
    expect(canonicalUri("/model/x-v1%3A0/invoke")).toBe("/model/x-v1%253A0/invoke");
  });

  it("produces an AWS4-HMAC-SHA256 header scoped to the date, region and service", () => {
    const h = signRequest(base);
    expect(h["x-amz-date"]).toBe("20260102T030405Z");
    expect(h.authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIDTEST\/20260102\/us-east-1\/bedrock\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/
    );
    expect(h).not.toHaveProperty("host");
  });

  it("is deterministic, and changes when the body does", () => {
    expect(signRequest(base).authorization).toBe(signRequest(base).authorization);
    expect(signRequest({ ...base, body: Buffer.from("{}") }).authorization).not.toBe(
      signRequest(base).authorization
    );
  });

  it("signs the session token when there is one", () => {
    const h = signRequest({ ...base, credentials: { ...credentials, sessionToken: "TOKEN" } });
    expect(h["x-amz-security-token"]).toBe("TOKEN");
    expect(h.authorization).toContain(
      "SignedHeaders=host;x-amz-content-sha256;x-amz-date;x-amz-security-token,"
    );
  });
});

describe("AWS credentials", () => {
  const cli = JSON.stringify({
    Version: 1,
    AccessKeyId: "AKID",
    SecretAccessKey: "SECRET",
    SessionToken: "TOKEN",
    Expiration: "2026-01-01T01:00:00Z",
  });

  it("prefers keys in the environment and never runs the CLI for them", async () => {
    const exec = vi.fn();
    const p = createCredentialProvider(
      { AWS_ACCESS_KEY_ID: "A", AWS_SECRET_ACCESS_KEY: "S" },
      exec
    );
    expect(await p.get()).toMatchObject({ accessKeyId: "A", secretAccessKey: "S" });
    expect(exec).not.toHaveBeenCalled();
  });

  it("caches the CLI's answer until shortly before it expires", async () => {
    let now = Date.parse("2026-01-01T00:00:00Z");
    const exec = vi.fn(async () => cli);
    const p = createCredentialProvider({}, exec, () => now);
    expect(await p.get()).toMatchObject({ accessKeyId: "AKID", sessionToken: "TOKEN" });
    await p.get();
    expect(exec).toHaveBeenCalledTimes(1);
    now = Date.parse("2026-01-01T00:59:00Z"); // inside the refresh margin
    await p.get();
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it("loads again after invalidate(), so refreshed credentials need no restart", async () => {
    const exec = vi.fn(async () => cli);
    const p = createCredentialProvider({}, exec, () => 0);
    await p.get();
    p.invalidate();
    await p.get();
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it("says which profile failed and what to do", async () => {
    const p = createCredentialProvider({ AWS_PROFILE: "AI" }, async () => {
      throw new Error("token expired");
    });
    await expect(p.get()).rejects.toThrow(/profile "AI".*token expired.*Refresh/);
  });
});

describe("rendering a Bedrock capture", () => {
  /** One AWS event-stream frame, close enough to the real one for the decoder. */
  const frame = (event: object) =>
    "\u0000\u0000\u0001\u000b:event-type\u0007\u0000\u0005chunk:message-type\u0007\u0000\u0005event" +
    `{"bytes":"${Buffer.from(JSON.stringify(event)).toString("base64")}","p":"abc"}` +
    "\u00124";

  const responseRaw = [
    frame({ type: "message_start", message: { usage: { input_tokens: 3 } } }),
    frame({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
    frame({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello from " } }),
    frame({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Bedrock" } }),
    frame({ type: "content_block_stop", index: 0 }),
    frame({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 4 } }),
    frame({ type: "message_stop" }),
  ].join("");

  const render = (raw: string, headers = {}) => renderMarkdown({
    agent: "Claude Code",
    renderer: "anthropic",
    timestamp: "2026-01-01T00:00:00.000Z",
    method: "POST",
    path: "/model/us.anthropic.claude-haiku-4-5-20251001-v1%3A0/invoke-with-response-stream",
    statusCode: 200,
    headers,
    requestBody: Buffer.from(
      JSON.stringify({
        anthropic_version: "bedrock-2023-05-31",
        max_tokens: 10,
        messages: [{ role: "user", content: "hi" }],
      })
    ),
    responseRaw: raw,
  });
  const md = render(responseRaw);

  it("reads the model out of the URL, decoded", () => {
    expect(md).toContain("**model**: us.anthropic.claude-haiku-4-5-20251001-v1:0");
  });

  it("reassembles the streamed reply from the binary event stream", () => {
    expect(md).toContain("Hello from Bedrock");
    expect(md).toContain("end_turn");
  });

  it("shows an error Bedrock sent part-way through the stream", () => {
    const err =
      ":exception-type\u0007\u0000\u0013throttlingException:message-type\u0007\u0000\u0009exception" +
      '{"message":"Too many \\"requests\\""}';
    expect(render(responseRaw + err)).toContain('Bedrock stream error:** Too many "requests"');
  });

  it("redacts the AWS session token", () => {
    const out = render(responseRaw, { "x-amz-security-token": "SECRET-TOKEN" });
    expect(out).not.toContain("SECRET-TOKEN");
  });
});

describe("signedHeaders", () => {
  const env = { AWS_ACCESS_KEY_ID: "AKID", AWS_SECRET_ACCESS_KEY: "S" };
  const t = bedrock({ AWS_REGION: "us-east-1" }) as ResolvedTarget;
  const incoming = {
    "content-type": "application/json",
    authorization: "AWS4-HMAC-SHA256 Credential=OLD",
    "x-amz-security-token": "OLD",
  };

  it("replaces the agent's signature with a new one for Bedrock", async () => {
    const h = await signedHeaders(t, incoming, "POST", t.upstreamHost, "/model/m/invoke", Buffer.from("{}"), env);
    expect(h.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKID\//);
    expect(h).not.toHaveProperty("x-amz-security-token");
    expect(h["content-type"]).toBe("application/json");
  });

  it("leaves every other route's headers alone", async () => {
    const other = resolveChoice(
      { agent: "claude-code", provider: "anthropic" },
      { port: 8787, platform: "darwin" }
    ) as ResolvedTarget;
    expect(await signedHeaders(other, incoming, "POST", "x", "/", Buffer.alloc(0), env)).toBe(incoming);
  });
});

describe("Claude Code on Amazon Bedrock with an API key", () => {
  const t = resolveChoice(
    { agent: "claude-code", provider: "bedrock-api-key" },
    { port: 8787, platform: "darwin", env: { AWS_REGION: "eu-west-1" } }
  ) as ResolvedTarget;

  it("forwards to the region's host and passes the key through unsigned", async () => {
    expect(t.upstreamHost).toBe("bedrock-runtime.eu-west-1.amazonaws.com");
    expect(t.awsSigning).toBeUndefined();
    const headers = { authorization: "Bearer KEY" };
    expect(await signedHeaders(t, headers, "POST", t.upstreamHost, "/", Buffer.alloc(0))).toBe(headers);
  });

  it("never sets the flag that drops the key", () => {
    expect(t.command).toBe(
      "ANTHROPIC_BEDROCK_BASE_URL=http://localhost:8787 ENABLE_TOOL_SEARCH=true claude"
    );
  });
});
