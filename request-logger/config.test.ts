import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { clearChoice, loadChoice, saveChoice } from "./config";

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "request-logger-"));
  file = path.join(dir, ".agent-choice.json");
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("the remembered answer", () => {
  it("reads back what it wrote", () => {
    saveChoice(file, { agent: "codex", provider: "chatgpt" });
    expect(loadChoice(file)).toEqual({ agent: "codex", provider: "chatgpt" });
  });

  it("reads back an agent that has one provider only", () => {
    saveChoice(file, { agent: "claude-code" });
    expect(loadChoice(file)).toEqual({ agent: "claude-code", provider: undefined });
  });

  it("reports no answer when the file is not there", () => {
    expect(loadChoice(file)).toBeNull();
  });

  it("reports no answer when the file is damaged", () => {
    // A half-written file must not stop the tool. Ask again instead.
    fs.writeFileSync(file, "{ not json");
    expect(loadChoice(file)).toBeNull();
  });
});

describe("the remembered answer — the custom base URL exception", () => {
  it("reads back a custom base URL and wire format alongside the choice", () => {
    saveChoice(file, {
      agent: "opencode",
      provider: "custom",
      customBaseUrl: "http://localhost:11434",
      customRenderer: "openai",
    });
    expect(loadChoice(file)).toEqual({
      agent: "opencode",
      provider: "custom",
      customBaseUrl: "http://localhost:11434",
      customRenderer: "openai",
    });
  });

  it("holds nothing but the choice for an ordinary catalogue answer", () => {
    // The documented exception is only for a custom target. Everything else
    // still holds nothing beyond {agent, provider} on disk.
    saveChoice(file, { agent: "codex", provider: "chatgpt" });
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(Object.keys(raw).sort()).toEqual(["agent", "provider"]);
  });

  it("saves the custom base URL and renderer on disk for a custom answer", () => {
    saveChoice(file, {
      agent: "omp",
      provider: "custom",
      customBaseUrl: "http://localhost:11434",
      customRenderer: "raw",
    });
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(raw.customBaseUrl).toBe("http://localhost:11434");
    expect(raw.customRenderer).toBe("raw");
  });

  it("ignores a non-string customBaseUrl in a damaged or hand-edited file", () => {
    fs.writeFileSync(
      file,
      JSON.stringify({ agent: "opencode", provider: "custom", customBaseUrl: 42 })
    );
    expect(loadChoice(file)?.customBaseUrl).toBeUndefined();
  });
});

describe("clearChoice", () => {
  it("removes the file, so the next run asks again", () => {
    saveChoice(file, { agent: "gemini", provider: "api-key" });
    clearChoice(file);
    expect(fs.existsSync(file)).toBe(false);
    expect(loadChoice(file)).toBeNull();
  });

  it("does nothing when there is no file to remove", () => {
    // --force clears before it asks, and a first run has nothing to clear.
    expect(() => clearChoice(file)).not.toThrow();
  });
});
