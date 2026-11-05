import http from "node:http";
import net from "node:net";
import path from "node:path";
import { describe, it, expect, afterEach } from "vitest";
import { resolveChoice } from "./agents";
import {
  BURST_THRESHOLD,
  BURST_WINDOW_MS,
  burstKey,
  readSettings,
  rejectUpgrade,
  TEST_DIR_ENV,
  TEST_UPSTREAM_ENV,
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

  it("is /v1 for Claude Code on Vertex AI", () => {
    const target = proxyTarget(
      { agent: "claude-code", provider: "vertex" },
      PORT
    );
    expect(upstreamPathPrefix(target)).toBe("/v1");
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
      setTimeout(
        () => reject(new Error("upgrade attempt was not answered within 1s")),
        1000
      );
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

describe("readSettings (the test-only overrides)", () => {
  const HERE = path.join(path.sep, "course", "request-logger");

  it("keeps the saved choice and logs next to proxy.ts, and the real upstream, when neither is set", () => {
    // This is every student's run: nothing in their shell sets either variable.
    expect(readSettings({}, HERE)).toEqual({
      logDir: path.join(HERE, "logs"),
      stateFile: path.join(HERE, ".agent-choice.json"),
      upstreamOverride: null,
    });
  });

  it("treats an empty variable as unset", () => {
    expect(
      readSettings({ [TEST_DIR_ENV]: "", [TEST_UPSTREAM_ENV]: "" }, HERE)
    ).toEqual(readSettings({}, HERE));
  });

  it("ignores unrelated variables, PORT included", () => {
    expect(readSettings({ PORT: "9999", HOME: "/home/x" }, HERE)).toEqual(
      readSettings({}, HERE)
    );
  });

  it("moves both the saved choice and the logs folder under REQUEST_LOGGER_TEST_DIR", () => {
    const dir = path.join(path.sep, "tmp", "e2e-run");
    const settings = readSettings({ [TEST_DIR_ENV]: dir }, HERE);
    expect(settings.logDir).toBe(path.join(dir, "logs"));
    expect(settings.stateFile).toBe(path.join(dir, ".agent-choice.json"));
    expect(settings.upstreamOverride).toBeNull();
  });

  it("reads REQUEST_LOGGER_TEST_UPSTREAM as an origin", () => {
    const settings = readSettings(
      { [TEST_UPSTREAM_ENV]: "http://127.0.0.1:4010" },
      HERE
    );
    expect(settings.upstreamOverride?.origin).toBe("http://127.0.0.1:4010");
    expect(settings.logDir).toBe(path.join(HERE, "logs"));
  });

  it.each([
    ["not a URL", "localhost:4010"],
    ["a non-HTTP scheme", "ftp://127.0.0.1:4010"],
    ["a path", "http://127.0.0.1:4010/v1"],
    ["a query", "http://127.0.0.1:4010/?x=1"],
  ])("refuses an upstream override with %s", (_, value) => {
    expect(() => readSettings({ [TEST_UPSTREAM_ENV]: value }, HERE)).toThrow(
      TEST_UPSTREAM_ENV
    );
  });
});

describe("upstreamConnection with the test-only upstream override", () => {
  it("sends a catalogue target to the override instead of its fixed host", () => {
    const target = proxyTarget(
      { agent: "claude-code", provider: "anthropic" },
      PORT
    );
    expect(
      upstreamConnection(target, new URL("http://127.0.0.1:4010"))
    ).toEqual({ hostname: "127.0.0.1", port: 4010, useHttps: false });
  });

  it("sends a custom target to the override, and keeps its path prefix", () => {
    const target = proxyTarget(
      {
        agent: "opencode",
        provider: "custom",
        customBaseUrl: "https://opencode.ai/zen/go",
        customRenderer: "openai",
        customModel: "test-model",
      },
      PORT
    );
    expect(
      upstreamConnection(target, new URL("https://fake.test"))
    ).toEqual({ hostname: "fake.test", port: 443, useHttps: true });
    expect(upstreamPathPrefix(target)).toBe("/zen/go");
  });

  it("is a no-op when the override is null, which is the default", () => {
    const target = proxyTarget({ agent: "codex", provider: "openai" }, PORT);
    expect(upstreamConnection(target, null)).toEqual(upstreamConnection(target));
    expect(upstreamConnection(target)).toEqual({
      hostname: "api.openai.com",
      port: 443,
      useHttps: true,
    });
  });
});
