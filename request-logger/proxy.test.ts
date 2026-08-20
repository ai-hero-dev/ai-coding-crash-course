import { describe, it, expect } from "vitest";
import { resolveChoice } from "./agents";
import { upstreamConnection } from "./proxy";

const PORT = { port: 8787 };

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
