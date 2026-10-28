import { describe, expect, it, vi } from "vitest";
import {
  amzDate,
  buildCanonicalRequest,
  buildStringToSign,
  calculateSignature,
  canonicalPath,
  canonicalQuery,
  credentialScope,
  createCredentialCache,
  credentialsAreFresh,
  escapeUri,
  loadCredentials,
  parseExportedCredentials,
  REFRESH_MARGIN_MS,
  signRequest,
  type AwsCredentials,
} from "./aws-sigv4";

const CREDENTIALS: AwsCredentials = {
  accessKeyId: "AKIDEXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
  expiresAt: null,
};

describe("escapeUri", () => {
  it("encodes the RFC 3986 characters encodeURIComponent leaves alone", () => {
    expect(escapeUri("!'()*")).toBe("%21%27%28%29%2A");
  });

  it("leaves the unreserved set untouched", () => {
    expect(escapeUri("aZ0-_.~")).toBe("aZ0-_.~");
  });
});

describe("canonicalPath", () => {
  it("encodes a Bedrock path a second time so a versioned model ID matches", () => {
    // The colon in a versioned Bedrock model ID is the case this rule exists
    // for: signed without the second encoding, Bedrock answers 403.
    expect(
      canonicalPath("/model/us.anthropic.claude-sonnet-4-5-20250929-v1:0/invoke")
    ).toBe("/model/us.anthropic.claude-sonnet-4-5-20250929-v1%3A0/invoke");
  });

  it("keeps segment slashes as separators", () => {
    expect(canonicalPath("/model/us.anthropic.claude-opus-5/invoke-with-response-stream")).toBe(
      "/model/us.anthropic.claude-opus-5/invoke-with-response-stream"
    );
  });

  it("normalises dot segments away", () => {
    expect(canonicalPath("/a/./b/../c")).toBe("/a/c");
  });

  it("keeps a trailing slash, and collapses a bare root", () => {
    expect(canonicalPath("/a/b/")).toBe("/a/b/");
    expect(canonicalPath("/")).toBe("/");
  });
});

describe("canonicalQuery", () => {
  it("returns nothing for a request with no query string, as Bedrock's are", () => {
    expect(canonicalQuery("")).toBe("");
  });

  it("sorts by name, then by value", () => {
    expect(canonicalQuery("b=2&a=z&a=a")).toBe("a=a&a=z&b=2");
  });

  it("gives a valueless parameter an empty value", () => {
    expect(canonicalQuery("flag")).toBe("flag=");
  });

  it("encodes exactly once, so an already-encoded value is not doubled", () => {
    expect(canonicalQuery("q=a%20b")).toBe("q=a%20b");
  });
});

describe("amzDate", () => {
  it("formats the basic ISO 8601 stamp AWS requires", () => {
    expect(amzDate(new Date("2026-09-13T17:58:20.542Z"))).toBe("20260913T175820Z");
  });
});

/**
 * AWS's published `get-vanilla` test vector. It pins all three steps of the
 * algorithm against strings computed outside this codebase, which is the only
 * way to know the signer is right rather than merely self-consistent.
 *
 * It is exercised through the three building blocks rather than through
 * signRequest, because signRequest always signs an `x-amz-content-sha256` header
 * and the vector does not sign one — going through it could never reproduce
 * these bytes.
 */
describe("AWS get-vanilla vector", () => {
  const EMPTY_PAYLOAD_HASH =
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

  const canonicalRequest = buildCanonicalRequest({
    method: "GET",
    path: "/",
    signedHeaders: {
      host: "example.amazonaws.com",
      "x-amz-date": "20150830T123600Z",
    },
    payloadHash: EMPTY_PAYLOAD_HASH,
  });

  it("builds the vector's canonical request", () => {
    expect(canonicalRequest).toBe(
      [
        "GET",
        "/",
        "",
        "host:example.amazonaws.com",
        "x-amz-date:20150830T123600Z",
        "",
        "host;x-amz-date",
        EMPTY_PAYLOAD_HASH,
      ].join("\n")
    );
  });

  const scope = credentialScope("20150830", "us-east-1", "service");

  it("builds the vector's string to sign", () => {
    expect(buildStringToSign({ stamp: "20150830T123600Z", scope, canonicalRequest })).toBe(
      [
        "AWS4-HMAC-SHA256",
        "20150830T123600Z",
        "20150830/us-east-1/service/aws4_request",
        "bb579772317eb040ac9ed261061d46c1f17a8133879d6129b6e1c25292927e63",
      ].join("\n")
    );
  });

  it("derives the vector's signature", () => {
    expect(
      calculateSignature({
        secretAccessKey: CREDENTIALS.secretAccessKey,
        dateStamp: "20150830",
        region: "us-east-1",
        service: "service",
        stringToSign: buildStringToSign({
          stamp: "20150830T123600Z",
          scope,
          canonicalRequest,
        }),
      })
    ).toBe("5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31");
  });
});

describe("signRequest", () => {
  it("assembles the Authorization header AWS expects", () => {
    const headers = signRequest({
      method: "GET",
      path: "/",
      hostname: "example.amazonaws.com",
      region: "us-east-1",
      service: "service",
      body: Buffer.alloc(0),
      credentials: CREDENTIALS,
      now: new Date("2015-08-30T12:36:00Z"),
    });

    expect(headers["x-amz-date"]).toBe("20150830T123600Z");
    expect(headers.authorization).toContain(
      "Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request"
    );
    expect(headers.authorization).toContain(
      "SignedHeaders=host;x-amz-content-sha256;x-amz-date"
    );
    expect(headers.authorization).toMatch(/Signature=[0-9a-f]{64}$/);
  });

  it("hashes the body into x-amz-content-sha256", () => {
    const headers = signRequest({
      method: "POST",
      path: "/model/us.anthropic.claude-opus-5/invoke",
      hostname: "bedrock-runtime.us-east-1.amazonaws.com",
      region: "us-east-1",
      service: "bedrock",
      body: Buffer.from("{}"),
      credentials: CREDENTIALS,
    });
    // sha256("{}")
    expect(headers["x-amz-content-sha256"]).toBe(
      "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a"
    );
  });

  it("signs and sends the session token when the credentials are temporary", () => {
    const headers = signRequest({
      method: "POST",
      path: "/model/m/invoke",
      hostname: "bedrock-runtime.eu-west-1.amazonaws.com",
      region: "eu-west-1",
      service: "bedrock",
      body: Buffer.from("{}"),
      credentials: { ...CREDENTIALS, sessionToken: "session-token" },
    });
    expect(headers["x-amz-security-token"]).toBe("session-token");
    expect(headers.authorization).toContain("x-amz-security-token");
  });

  it("omits the session token header for long-lived keys", () => {
    const headers = signRequest({
      method: "POST",
      path: "/model/m/invoke",
      hostname: "bedrock-runtime.us-east-1.amazonaws.com",
      region: "us-east-1",
      service: "bedrock",
      body: Buffer.from("{}"),
      credentials: CREDENTIALS,
    });
    expect(headers).not.toHaveProperty("x-amz-security-token");
    expect(headers.authorization).not.toContain("x-amz-security-token");
  });

  it("brings an extra header into the signed set", () => {
    const headers = signRequest({
      method: "POST",
      path: "/model/m/invoke",
      hostname: "bedrock-runtime.us-east-1.amazonaws.com",
      region: "us-east-1",
      service: "bedrock",
      body: Buffer.from("{}"),
      credentials: CREDENTIALS,
      extraSignedHeaders: { "content-type": "application/json" },
    });
    expect(headers.authorization).toContain(
      "SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date"
    );
  });

  it("signs the host it is given, not the one the agent addressed", () => {
    const forHost = (hostname: string) =>
      signRequest({
        method: "POST",
        path: "/model/m/invoke",
        hostname,
        region: "us-east-1",
        service: "bedrock",
        body: Buffer.from("{}"),
        credentials: CREDENTIALS,
        now: new Date("2026-09-13T17:58:20.542Z"),
      }).authorization;

    // The whole reason this module exists: the two differ, so the agent's own
    // signature could never have been forwarded.
    expect(forHost("localhost:8787")).not.toBe(
      forHost("bedrock-runtime.us-east-1.amazonaws.com")
    );
  });

  it("signs the region it is given", () => {
    const forRegion = (region: string) =>
      signRequest({
        method: "POST",
        path: "/model/m/invoke",
        hostname: "bedrock-runtime.us-east-1.amazonaws.com",
        region,
        service: "bedrock",
        body: Buffer.from("{}"),
        credentials: CREDENTIALS,
        now: new Date("2026-09-13T17:58:20.542Z"),
      }).authorization;

    expect(forRegion("us-east-1")).not.toBe(forRegion("eu-west-1"));
  });
});

describe("parseExportedCredentials", () => {
  it("reads the credential-process shape the AWS CLI prints", () => {
    expect(
      parseExportedCredentials(
        JSON.stringify({
          Version: 1,
          AccessKeyId: "ASIA123",
          SecretAccessKey: "secret",
          SessionToken: "token",
          Expiration: "2026-09-13T21:50:24+00:00",
        })
      )
    ).toEqual({
      accessKeyId: "ASIA123",
      secretAccessKey: "secret",
      sessionToken: "token",
      expiresAt: Date.parse("2026-09-13T21:50:24+00:00"),
    });
  });

  it("treats credentials with no expiry as long-lived", () => {
    expect(
      parseExportedCredentials(
        JSON.stringify({ AccessKeyId: "AKIA123", SecretAccessKey: "secret" })
      )
    ).toEqual({
      accessKeyId: "AKIA123",
      secretAccessKey: "secret",
      sessionToken: undefined,
      expiresAt: null,
    });
  });

  it.each([
    ["not JSON at all", "aws: command not found"],
    ["JSON without the keys", '{"Version":1}'],
  ])("explains itself when the output is %s", (_name, raw) => {
    expect(() => parseExportedCredentials(raw)).toThrow();
  });
});

describe("loadCredentials", () => {
  it("asks the AWS CLI for the named profile", () => {
    const runner = vi.fn(() =>
      JSON.stringify({ AccessKeyId: "ASIA1", SecretAccessKey: "s", SessionToken: "t" })
    );
    loadCredentials({ profile: "claude-code-bedrock", runner });
    expect(runner).toHaveBeenCalledWith("aws", [
      "configure",
      "export-credentials",
      "--format",
      "process",
      "--profile",
      "claude-code-bedrock",
    ]);
  });

  it("omits the profile flag when none was configured", () => {
    const runner = vi.fn(() =>
      JSON.stringify({ AccessKeyId: "AKIA1", SecretAccessKey: "s" })
    );
    loadCredentials({ runner });
    expect(runner).toHaveBeenCalledWith("aws", [
      "configure",
      "export-credentials",
      "--format",
      "process",
    ]);
  });

  it("points at `aws sso login` for the named profile when the CLI fails", () => {
    const runner = vi.fn(() => {
      throw new Error("Error loading SSO Token: Token has expired");
    });
    expect(() => loadCredentials({ profile: "p", runner })).toThrow(
      /aws sso login --profile p/
    );
  });

  it("points at AWS_PROFILE, not at logging in, when no profile was named", () => {
    // The common failure for this provider is a shell that never had
    // AWS_PROFILE set, because the profile lives in Claude Code's own settings.
    // Sending that student to `aws sso login` is the least useful advice going.
    const runner = vi.fn(() => {
      throw new Error("Unable to retrieve credentials: no credentials found");
    });
    let message = "";
    try {
      loadCredentials({ runner });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("AWS_PROFILE=your-profile");
    expect(message).toContain("~/.claude/settings.json");
    expect(message).not.toContain("aws sso login");
  });
});

describe("credentialsAreFresh", () => {
  const now = Date.parse("2026-09-13T18:00:00Z");

  it("has nothing to reuse before the first read", () => {
    expect(credentialsAreFresh(null, now)).toBe(false);
  });

  it("reuses credentials that never expire", () => {
    expect(credentialsAreFresh(CREDENTIALS, now)).toBe(true);
  });

  it("reuses credentials with time left beyond the refresh margin", () => {
    const expiresAt = now + REFRESH_MARGIN_MS + 1_000;
    expect(credentialsAreFresh({ ...CREDENTIALS, expiresAt }, now)).toBe(true);
  });

  it("re-reads credentials expiring inside the refresh margin", () => {
    const expiresAt = now + REFRESH_MARGIN_MS - 1_000;
    expect(credentialsAreFresh({ ...CREDENTIALS, expiresAt }, now)).toBe(false);
  });
});

describe("createCredentialCache", () => {
  it("shells out once while the credentials stay fresh", () => {
    const runner = vi.fn(() =>
      JSON.stringify({ AccessKeyId: "AKIA1", SecretAccessKey: "s" })
    );
    const read = createCredentialCache({ runner });
    read();
    read();
    read();
    expect(runner).toHaveBeenCalledOnce();
  });

  it("re-reads once the cached credentials are close to expiring", () => {
    const start = Date.parse("2026-09-13T18:00:00Z");
    let clock = start;
    const runner = vi.fn(() =>
      JSON.stringify({
        AccessKeyId: "ASIA1",
        SecretAccessKey: "s",
        SessionToken: "t",
        Expiration: new Date(clock + REFRESH_MARGIN_MS + 60_000).toISOString(),
      })
    );
    const read = createCredentialCache({ runner, now: () => clock });

    read();
    expect(runner).toHaveBeenCalledOnce();

    clock += 90_000; // now inside the refresh margin of the first expiry
    read();
    expect(runner).toHaveBeenCalledTimes(2);
  });
});
