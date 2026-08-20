import { describe, expect, it, vi } from "vitest";
import { discoverModelIds, parseModelIds } from "./model-discovery";

describe("parseModelIds", () => {
  it("parses model IDs from a standard OpenAI-compatible response", () => {
    expect(
      parseModelIds({ data: [{ id: "qwen3:8b" }, { id: "deepseek-r1" }] })
    ).toEqual(["qwen3:8b", "deepseek-r1"]);
  });

  it("ignores entries without usable string IDs", () => {
    expect(
      parseModelIds({
        data: [{ id: "qwen3:8b" }, {}, { id: 42 }, { id: "" }, { id: "   " }],
      })
    ).toEqual(["qwen3:8b"]);
  });

  it.each([null, {}, { data: {} }])(
    "returns no IDs for malformed data: %j",
    (body) => {
      expect(parseModelIds(body)).toEqual([]);
    }
  );
});

describe("discoverModelIds", () => {
  it("queries the custom origin's /v1/models endpoint once without credentials", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [{ id: "local-model" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );

    await expect(
      discoverModelIds("http://localhost:11434/a/path", { fetchImpl })
    ).resolves.toEqual(["local-model"]);

    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("http://localhost:11434/v1/models");
    expect(init).not.toHaveProperty("headers");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it.each([
    ["network failure", () => Promise.reject(new Error("offline"))],
    [
      "unsuccessful status",
      () => Promise.resolve(new Response("no", { status: 500 })),
    ],
    ["malformed JSON", () => Promise.resolve(new Response("not json"))],
  ])("falls back to no IDs after %s", async (_name, implementation) => {
    await expect(
      discoverModelIds("http://localhost:11434", {
        fetchImpl: vi.fn(implementation),
      })
    ).resolves.toEqual([]);
  });

  it("aborts discovery after the configured timeout and falls back to no IDs", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(init.signal?.reason)
        );
      });
    });

    const result = discoverModelIds("http://localhost:11434", {
      fetchImpl,
      timeoutMs: 25,
    });
    await vi.advanceTimersByTimeAsync(25);

    await expect(result).resolves.toEqual([]);
    vi.useRealTimers();
  });
});
