import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { probeLocalServer } from "./local";

// A fake local model server. It answers the OpenAI and Ollama model
// endpoints, so the probe can be tested without a real model on the machine.
// The path it is asked to serve is chosen per test, so the same server can
// stand in for an OpenAI-compatible server or an Ollama.
const MODELS = {
  openai: { data: [{ id: "llama3-8b" }, { id: "gemma-2b" }] },
  ollama: { models: [{ name: "llama3:8b" }] },
};

let server: http.Server;
let port: number;
let wire: "openai" | "ollama";

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const path = req.url ?? "/";
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (wire === "openai" && path === "/v1/models") return send(200, MODELS.openai);
    if (wire === "ollama" && path === "/api/tags") return send(200, MODELS.ollama);
    send(404, { error: "not found" });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  port = typeof address === "object" && address ? address.port : 0;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const url = () => `http://127.0.0.1:${port}`;

describe("probeLocalServer", () => {
  it("reads an OpenAI-compatible server's models", async () => {
    wire = "openai";
    const probe = await probeLocalServer(url());
    expect(probe.ok).toBe(true);
    expect(probe.models).toEqual(["llama3-8b", "gemma-2b"]);
  });

  it("reads a trailing /v1 off the address, because the probe adds it back", async () => {
    wire = "openai";
    const probe = await probeLocalServer(`${url()}/v1`);
    expect(probe.ok).toBe(true);
    expect(probe.models).toEqual(["llama3-8b", "gemma-2b"]);
  });

  it("reads an Ollama server through its native tag list", async () => {
    wire = "ollama";
    const probe = await probeLocalServer(url());
    expect(probe.ok).toBe(true);
    expect(probe.models).toEqual(["llama3:8b"]);
  });

  it("reports an error when the server offers no models", async () => {
    // A server that answers none of the model endpoints, but does answer, is
    // not a model server as far as this tool is concerned.
    wire = "openai";
    const probe = await probeLocalServer(`${url()}/definitely-not-a-model-endpoint`);
    expect(probe.ok).toBe(false);
    expect(probe.models).toEqual([]);
  });

  it("reports an error for an address that is not a URL", async () => {
    const probe = await probeLocalServer("not a url");
    expect(probe.ok).toBe(false);
    expect(probe.error).toBeDefined();
  });

  it("reports an error when nothing is listening", async () => {
    // Port 1 is effectively never open, so the probe must time out and fail
    // rather than hang the wizard.
    const probe = await probeLocalServer("http://127.0.0.1:1");
    expect(probe.ok).toBe(false);
    expect(probe.error).toBeDefined();
  });
});
