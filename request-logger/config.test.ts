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

  it("reads back a local model choice with its server and model", () => {
    // The wizard stores the address and model of the student's local server.
    // Losing either on a re-read would make the tool ask again or forward to
    // nothing, so the round-trip must keep both.
    const choice = {
      agent: "omp",
      provider: "local",
      localUrl: "http://127.0.0.1:8000",
      localModel: "llama3-8b",
    };
    saveChoice(file, choice);
    expect(loadChoice(file)).toEqual(choice);
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
