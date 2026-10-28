import http from "node:http";
import net from "node:net";
import { describe, it, expect, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { resolveChoice } from "./agents";
import {
  applySigning,
  BURST_THRESHOLD,
  BURST_WINDOW_MS,
  burstKey,
  rejectUpgrade,
  trackBurst,
  upstreamConnection,
  upstreamPathPrefix,
  type BurstState,
} from "./proxy";

const PORT = { port: 8787, platform: "linux" as NodeJS.Platform };

/** Resolve, and fail loudly if the answer was not something the proxy can route to. */
function proxyTarget(...args: Parameters<typeof resolveChoice>) {
  const result = resolveChoice(...args);
  if (result.kind !== "target" && result.kind !== "custom-target") {
    throw new Error(`expected a routable target, got ${result.kind}`);
  }
  return result;
}

describe("upstreamConnection", () => {
  it("keeps a catalogue target on https and port 443, unchanged", () => {
    const target = proxyTarget(
      { agent: "claude-code", provider: "anthropic" },
      PORT
    );
    expect(upstreamConnection(target)).toEqual({
      hostname: "api.anthropic.com",
      port: 443,
      useHttps: true,
    });
  });

  it("keeps every catalogue target on https and 443, whichever agent it is", () => {
    const target = proxyTarget({ agent: "gemini", provider: "api-key" }, PORT);
    expect(upstreamConnection(target)).toEqual({
      hostname: "generativelanguage.googleapis.com",
      port: 443,
      useHttps: true,
    });
  });

  it("uses https on a custom target whose base URL says https, with no port given", () => {
    const target = proxyTarget(
      {
        agent: "opencode",
        provider: "custom",
        customBaseUrl: "https://api.deepseek.com",
        customRenderer: "openai",
        customModel: "test-model",
      },
      PORT
    );
    expect(upstreamConnection(target)).toEqual({
      hostname: "api.deepseek.com",
      port: 443,
      useHttps: true,
    });
  });

  it("uses http on a custom target whose base URL says http, with an explicit port", () => {
    const target = proxyTarget(
      {
        agent: "omp",
        customBaseUrl: "http://localhost:11434",
        customRenderer: "raw",
      },
      PORT
    );
    expect(upstreamConnection(target)).toEqual({
      hostname: "localhost",
      port: 11434,
      useHttps: false,
    });
  });

  it("defaults a plain http:// custom target with no explicit port to 80", () => {
    const target = proxyTarget(
      {
        agent: "omp",
        customBaseUrl: "http://model-server.internal",
        customRenderer: "raw",
      },
      PORT
    );
    expect(upstreamConnection(target)).toEqual({
      hostname: "model-server.internal",
      port: 80,
      useHttps: false,
    });
  });

  it("defaults a plain https:// custom target with no explicit port to 443", () => {
    const target = proxyTarget(
      {
        agent: "omp",
        customBaseUrl: "https://model-server.internal",
        customRenderer: "raw",
      },
      PORT
    );
    expect(upstreamConnection(target)).toEqual({
      hostname: "model-server.internal",
      port: 443,
      useHttps: true,
    });
  });

  it("respects an explicit port on an https:// custom target too", () => {
    const target = proxyTarget(
      {
        agent: "omp",
        customBaseUrl: "https://model-server.internal:8443",
        customRenderer: "raw",
      },
      PORT
    );
    expect(upstreamConnection(target)).toEqual({
      hostname: "model-server.internal",
      port: 8443,
      useHttps: true,
    });
  });
});

describe("upstreamPathPrefix", () => {
  // Regression coverage for #74: OpenCode Go's custom base URL,
  // https://opencode.ai/zen/go, carries a path prefix the upstream actually
  // needs. agents.ts used to reduce every CustomTarget's upstreamBaseUrl to
  // `.origin`, silently dropping it, so handle() forwarded requests straight
  // to the bare host and every request 404'd — a working manual curl to the
  // full path, but a broken one through the proxy.
  it("is empty for a catalogue target, which never carries a path", () => {
    const target = proxyTarget(
      { agent: "claude-code", provider: "anthropic" },
      PORT
    );
    expect(upstreamPathPrefix(target)).toBe("");
  });

  it("is empty for a custom target whose base URL is a bare origin", () => {
    const target = proxyTarget(
      {
        agent: "omp",
        customBaseUrl: "https://api.deepseek.com",
        customRenderer: "raw",
      },
      PORT
    );
    expect(upstreamPathPrefix(target)).toBe("");
  });

  it("carries the path segment from a custom base URL with one", () => {
    const target = proxyTarget(
      {
        agent: "omp",
        customBaseUrl: "https://opencode.ai/zen/go",
        customRenderer: "raw",
      },
      PORT
    );
    expect(upstreamPathPrefix(target)).toBe("/zen/go");
  });

  it("joins against the agent's own request path with no doubled or missing slash", () => {
    const target = proxyTarget(
      {
        agent: "omp",
        customBaseUrl: "https://opencode.ai/zen/go",
        customRenderer: "raw",
      },
      PORT
    );
    const reqPath = "/v1/chat/completions";
    expect(upstreamPathPrefix(target) + reqPath).toBe(
      "/zen/go/v1/chat/completions"
    );
  });
});

describe("rejectUpgrade", () => {
  let server: http.Server | undefined;

  afterEach(() => {
    server?.close();
    server = undefined;
  });

  /**
   * Codex on a ChatGPT subscription probes /backend-api/codex/responses with
   * a WebSocket upgrade before falling back to plain HTTP. Before this
   * handler existed, the proxy had no 'upgrade' listener on either leg, so
   * the attempt did not fail closed — it stalled forever, because a
   * successful upstream upgrade arrives on the outbound request's 'upgrade'
   * event rather than 'response', which nothing was listening for. This test
   * sends a real upgrade handshake at a server wired the way proxy.ts wires
   * it, and requires a prompt, well-formed 426 — not a hang and not a bare
   * connection drop — because a bare drop is what let the bug through last
   * time even though Node's default already closes unhandled upgrades.
   */
  it("answers a WebSocket upgrade attempt with 426 immediately, instead of leaving the client waiting", async () => {
    server = http.createServer((_req, res) => {
      res.writeHead(200);
      res.end("should not be reached by an upgrade attempt");
    });
    server.on("upgrade", rejectUpgrade);

    await new Promise<void>((resolve) => server!.listen(0, resolve));
    const { port } = server.address() as net.AddressInfo;

    const response = await new Promise<string>((resolve, reject) => {
      const socket = net.connect(port, "127.0.0.1", () => {
        socket.write(
          "GET /backend-api/codex/responses HTTP/1.1\r\n" +
            "Host: localhost\r\n" +
            "Connection: Upgrade\r\n" +
            "Upgrade: websocket\r\n" +
            "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n" +
            "Sec-WebSocket-Version: 13\r\n" +
            "\r\n"
        );
      });
      let data = "";
      socket.on("data", (chunk) => (data += chunk.toString()));
      socket.on("close", () => resolve(data));
      socket.on("error", reject);
      // A hang here means the fix regressed to the old silent-drop behavior;
      // fail fast rather than letting vitest's own timeout do it, so the
      // failure message is about the upgrade, not a generic timeout.
      setTimeout(() => reject(new Error("upgrade attempt was not answered within 1s")), 1000);
    });

    expect(response).toContain("HTTP/1.1 426");
    expect(response).toContain("Connection: close");
  });
});

describe("trackBurst", () => {
  // Reproduces what was witnessed with OMP against http://api.anthropic.com:
  // the wrong scheme gets a fast 400 with no retry guidance, and OMP retried
  // it immediately and repeatedly with no backoff, writing one log file per
  // retry. This is the guard that stops that turning into thousands of files.
  const KEY = burstKey("POST", "/v1/messages", 400);

  it("does not suppress ordinary, spaced-out repeats of the same call", () => {
    let state: BurstState | null = null;
    let now = 0;
    for (let i = 0; i < BURST_THRESHOLD + 5; i++) {
      const result = trackBurst(state, KEY, now);
      expect(result.suppressed).toBe(false);
      state = result.state;
      now += BURST_WINDOW_MS + 1; // always outside the window
    }
  });

  it("suppresses once the same method+path+status repeats past the threshold inside the window", () => {
    let state: BurstState | null = null;
    let lastResult;
    const now = 0;
    for (let i = 0; i < BURST_THRESHOLD; i++) {
      lastResult = trackBurst(state, KEY, now); // all in the same instant
      state = lastResult.state;
    }
    expect(lastResult!.suppressed).toBe(false); // exactly at the threshold: not yet over it

    const over = trackBurst(state, KEY, now);
    expect(over.suppressed).toBe(true);
    expect(over.justDetected).toBe(true);
  });

  it("reports justDetected only once per burst, not on every suppressed repeat", () => {
    let state: BurstState | null = null;
    const now = 0;
    for (let i = 0; i < BURST_THRESHOLD; i++) {
      state = trackBurst(state, KEY, now).state;
    }

    const first = trackBurst(state, KEY, now);
    expect(first.justDetected).toBe(true);

    const second = trackBurst(first.state, KEY, now);
    expect(second.suppressed).toBe(true);
    expect(second.justDetected).toBe(false);
  });

  it("never suppresses a different call, even mid-burst on another one", () => {
    let state: BurstState | null = null;
    const now = 0;
    for (let i = 0; i < BURST_THRESHOLD + 10; i++) {
      state = trackBurst(state, KEY, now).state;
    }

    const other = trackBurst(state, burstKey("POST", "/v1/messages", 200), now);
    expect(other.suppressed).toBe(false);
  });

  it("resets the count once the gap between repeats exceeds the window, so a burst that stops is forgotten", () => {
    let state: BurstState | null = null;
    const now = 0;
    for (let i = 0; i < BURST_THRESHOLD + 10; i++) {
      state = trackBurst(state, KEY, now).state;
    }

    const afterGap = trackBurst(state, KEY, now + BURST_WINDOW_MS + 1);
    expect(afterGap.suppressed).toBe(false);
    expect(afterGap.state.count).toBe(1);
  });
});

describe("applySigning", () => {
  const CREDENTIALS = {
    accessKeyId: "ASIAEXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
    sessionToken: "fresh-session-token",
    expiresAt: null,
  };

  const SIGNING = {
    kind: "aws-sigv4" as const,
    service: "bedrock" as const,
    region: "us-east-1",
  };

  /**
   * Headers as they arrive from Claude Code in Bedrock mode: signed for
   * `Host: localhost`, which is exactly why they cannot be forwarded.
   */
  const AGENT_HEADERS = {
    "content-type": "application/json",
    "anthropic-version": "2023-06-01",
    authorization: "AWS4-HMAC-SHA256 Credential=STALE/20260913/us-east-1/bedrock/aws4_request",
    "x-amz-date": "20260913T175820Z",
    "x-amz-content-sha256": "0000000000000000000000000000000000000000000000000000000000000000",
    "x-amz-security-token": "stale-session-token",
    host: "bedrock-runtime.us-east-1.amazonaws.com",
  };

  function sign(headers: Record<string, string> = AGENT_HEADERS) {
    return applySigning(headers, {
      signing: SIGNING,
      credentials: CREDENTIALS,
      method: "POST",
      path: "/model/us.anthropic.claude-opus-5/invoke-with-response-stream",
      hostname: "bedrock-runtime.us-east-1.amazonaws.com",
      body: Buffer.from('{"anthropic_version":"bedrock-2023-05-31"}'),
      now: new Date("2026-09-13T18:30:00.000Z"),
    });
  }

  it("replaces the agent's signature rather than forwarding it", () => {
    const signed = sign();
    expect(signed.authorization).not.toBe(AGENT_HEADERS.authorization);
    expect(signed.authorization).toContain("Credential=ASIAEXAMPLE/20260913/us-east-1/bedrock/");
  });

  it("replaces every stale x-amz header the agent's signature covered", () => {
    // A stale one left alongside a fresh signature is a 403, not a spare header:
    // the fresh signature covers its own copy of each of these.
    const signed = sign();
    expect(signed["x-amz-date"]).toBe("20260913T183000Z");
    expect(signed["x-amz-security-token"]).toBe("fresh-session-token");
    expect(signed["x-amz-content-sha256"]).not.toBe(
      AGENT_HEADERS["x-amz-content-sha256"]
    );
  });

  it("hashes the body that is actually forwarded", () => {
    const signed = sign();
    expect(signed["x-amz-content-sha256"]).toBe(
      createHash("sha256")
        .update('{"anthropic_version":"bedrock-2023-05-31"}')
        .digest("hex")
    );
  });

  it("keeps the agent's own non-AWS headers", () => {
    // These are what the capture is for. Signing must not quietly drop them.
    const signed = sign();
    expect(signed["anthropic-version"]).toBe("2023-06-01");
    expect(signed["content-type"]).toBe("application/json");
  });

  it("brings content-type inside the signature", () => {
    expect(sign().authorization).toContain("SignedHeaders=content-type;host;");
  });

  it("signs a request that arrived with no content-type at all", () => {
    const { "content-type": _dropped, ...withoutContentType } = AGENT_HEADERS;
    const signed = sign(withoutContentType);
    expect(signed.authorization).toContain("SignedHeaders=host;");
    expect(signed.authorization).not.toContain("content-type");
  });
});
