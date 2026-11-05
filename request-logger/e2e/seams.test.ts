/**
 * The two test-only overrides, driven through the real proxy.ts process with
 * no agent at all: fetch() plays the agent. Fast enough for the unit suite,
 * and the proof that the e2e driver's seams work before any recipe runs.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DUMMY_KEY, freePort, startProxy, type StartedProxy } from "./driver";
import {
  CANNED_REPLY,
  startFakeUpstream,
  type FakeUpstream,
} from "./fake-upstream";

let proxy: StartedProxy | undefined;
let upstream: FakeUpstream | undefined;
afterEach(async () => {
  proxy?.stop();
  await upstream?.close();
  proxy = upstream = undefined;
});

async function waitForCapture(logs: string): Promise<string> {
  for (let i = 0; i < 50; i++) {
    const md = fs.existsSync(logs)
      ? fs.readdirSync(logs).filter((f) => f.endsWith(".md"))
      : [];
    if (md.length > 0) return fs.readFileSync(path.join(logs, md[0]), "utf8");
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`no capture in ${logs}`);
}

describe("the test-only overrides, through the real proxy", () => {
  it.each([
    {
      name: "a catalogue target's fixed host (Anthropic, streamed)",
      choice: { agent: "claude-code", provider: "anthropic" },
      path: "/v1/messages",
      headers: { "x-api-key": DUMMY_KEY } as Record<string, string>,
      body: {
        model: "m",
        stream: true,
        messages: [{ role: "user", content: "seam-prompt" }],
      },
    },
    {
      name: "a catalogue target's fixed host (OpenAI chat, streamed)",
      choice: { agent: "opencode", provider: "openai" },
      path: "/v1/chat/completions",
      headers: { authorization: `Bearer ${DUMMY_KEY}` } as Record<
        string,
        string
      >,
      body: {
        model: "m",
        stream: true,
        messages: [{ role: "user", content: "seam-prompt" }],
      },
    },
    {
      name: "a custom target, keeping its path prefix",
      choice: {
        agent: "opencode",
        provider: "custom",
        customBaseUrl: "https://example.invalid/zen/go",
        customRenderer: "openai" as const,
        customModel: "m",
      },
      path: "/v1/chat/completions",
      upstreamPath: "/zen/go/v1/chat/completions",
      headers: { authorization: `Bearer ${DUMMY_KEY}` } as Record<
        string,
        string
      >,
      body: {
        model: "m",
        stream: true,
        messages: [{ role: "user", content: "seam-prompt" }],
      },
    },
  ])(
    "redirects $name and logs into the test dir",
    async (c) => {
      const stateDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "request-logger-seams-")
      );
      upstream = await startFakeUpstream();
      const port = await freePort();
      proxy = await startProxy({
        stateDir,
        upstream: upstream.origin,
        port,
        choice: c.choice,
      });
      expect(proxy.banner).toContain("REQUEST_LOGGER_TEST_UPSTREAM is set");

      const res = await fetch(`http://127.0.0.1:${port}${c.path}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...c.headers },
        body: JSON.stringify(c.body),
      });
      expect(res.status).toBe(200);
      expect(await res.text()).toContain(CANNED_REPLY);

      expect(upstream.seen.map((r) => r.url)).toEqual([
        c.upstreamPath ?? c.path,
      ]);
      const capture = await waitForCapture(path.join(stateDir, "logs"));
      expect(capture).toContain("seam-prompt");
      expect(capture).toContain(`<assistant-text>\n\n${CANNED_REPLY}`);
      expect(capture).toContain("[REDACTED]");
      expect(capture).not.toContain(DUMMY_KEY);
      fs.rmSync(stateDir, { recursive: true, force: true });
    },
    30_000
  );
});
