import http from "node:http";
import net from "node:net";
import { describe, it, expect, afterEach } from "vitest";
import { resolveChoice } from "./agents";
import { rejectUpgrade, upstreamConnection } from "./proxy";

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
    const target = proxyTarget({ agent: "claude-code" }, PORT);
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
