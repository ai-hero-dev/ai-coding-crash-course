import { beforeEach, describe, expect, it, vi } from "vitest";

const promptMocks = vi.hoisted(() => ({
  cancel: vi.fn(),
  confirm: vi.fn(),
  intro: vi.fn(),
  isCancel: vi.fn(() => false),
  select: vi.fn(),
  text: vi.fn(),
}));

const discoveryMocks = vi.hoisted(() => ({
  discoverModelIds: vi.fn(),
}));

vi.mock("@clack/prompts", () => promptMocks);
vi.mock("./model-discovery", () => discoveryMocks);

import { askChoice } from "./config";

function customOpenCodeAnswers() {
  promptMocks.select.mockResolvedValueOnce("opencode");
  promptMocks.select.mockResolvedValueOnce("custom");
  promptMocks.text.mockResolvedValueOnce("http://localhost:11434");
  promptMocks.select.mockResolvedValueOnce("openai");
}

function customPiAnswers(renderer: "openai" | "anthropic" | "raw" = "openai") {
  promptMocks.select.mockResolvedValueOnce("pi");
  promptMocks.select.mockResolvedValueOnce("custom");
  promptMocks.text.mockResolvedValueOnce("http://localhost:11434");
  promptMocks.select.mockResolvedValueOnce(renderer);
}

beforeEach(() => {
  for (const mock of Object.values(promptMocks)) mock.mockReset();
  discoveryMocks.discoverModelIds.mockReset();
  promptMocks.isCancel.mockReturnValue(false);
});

describe("the OpenCode custom OpenAI-compatible model step", () => {
  it("keeps one generic Custom base URL option and adds no local-provider option", async () => {
    promptMocks.select.mockResolvedValueOnce("opencode");
    promptMocks.select.mockImplementationOnce(async (options) => {
      const labels = options.options.map(
        (option: { label: string }) => option.label
      );
      expect(
        labels.filter((label: string) => label === "Custom base URL")
      ).toHaveLength(1);
      expect(
        labels.some((label: string) => /local.*provider/i.test(label))
      ).toBe(false);
      return "anthropic";
    });

    await askChoice({ offerToRemember: false });

    expect(discoveryMocks.discoverModelIds).not.toHaveBeenCalled();
  });

  it("offers discovered models and keeps manual entry as the final option", async () => {
    customOpenCodeAnswers();
    discoveryMocks.discoverModelIds.mockResolvedValue([
      "qwen3:8b",
      "deepseek-r1",
    ]);
    promptMocks.select.mockImplementationOnce(async (options) => {
      expect(
        options.options.map((option: { label: string }) => option.label)
      ).toEqual(["qwen3:8b", "deepseek-r1", "Enter a model ID manually"]);
      return options.options[0].value;
    });

    const answer = await askChoice({ offerToRemember: false });

    expect(discoveryMocks.discoverModelIds).toHaveBeenCalledOnce();
    expect(discoveryMocks.discoverModelIds).toHaveBeenCalledWith(
      "http://localhost:11434"
    );
    expect(answer.choice.customModel).toBe("qwen3:8b");
  });

  it("accepts required manual input even when discovery succeeded", async () => {
    customOpenCodeAnswers();
    discoveryMocks.discoverModelIds.mockResolvedValue([
      "qwen3:8b",
      "deepseek-r1",
    ]);
    promptMocks.select.mockImplementationOnce(async (options) => {
      return options.options.at(-1).value;
    });
    promptMocks.text.mockImplementationOnce(async (options) => {
      expect(options.validate("")).toBe("A model ID is required.");
      expect(options.validate("   ")).toBe("A model ID is required.");
      expect(options.validate("model with spaces")).toBeUndefined();
      return "  model with spaces  ";
    });

    const answer = await askChoice({ offerToRemember: false });

    expect(answer.choice.customModel).toBe("model with spaces");
  });

  it("uses the only discovered model without asking", async () => {
    customOpenCodeAnswers();
    discoveryMocks.discoverModelIds.mockResolvedValue(["qwen3:8b"]);
    // Three prior selects only: agent, "custom", renderer. A fourth select
    // call here would mean the model step asked anyway.
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const answer = await askChoice({ offerToRemember: false });

    expect(promptMocks.select).toHaveBeenCalledTimes(3);
    expect(answer.choice.customModel).toBe("qwen3:8b");
    expect(log).toHaveBeenCalledWith(expect.stringContaining("qwen3:8b"));
    log.mockRestore();
  });

  it("warns and immediately requires manual entry when discovery returns no IDs", async () => {
    customOpenCodeAnswers();
    discoveryMocks.discoverModelIds.mockResolvedValue([]);
    const warning = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    promptMocks.text.mockResolvedValueOnce("fallback-model");

    const answer = await askChoice({ offerToRemember: false });

    expect(warning).toHaveBeenCalledWith(expect.stringContaining("model"));
    expect(promptMocks.select).toHaveBeenCalledTimes(3);
    expect(answer.choice.customModel).toBe("fallback-model");
    warning.mockRestore();
  });

  it.each(["anthropic", "raw"])(
    "does not discover models for the %s custom renderer",
    async (renderer) => {
      promptMocks.select.mockResolvedValueOnce("opencode");
      promptMocks.select.mockResolvedValueOnce("custom");
      promptMocks.text.mockResolvedValueOnce("http://localhost:11434");
      promptMocks.select.mockResolvedValueOnce(renderer);

      const answer = await askChoice({ offerToRemember: false });

      expect(discoveryMocks.discoverModelIds).not.toHaveBeenCalled();
      expect(answer.choice.customModel).toBeUndefined();
    }
  );

  it("does not discover models for another agent's OpenAI-compatible custom target", async () => {
    promptMocks.select.mockResolvedValueOnce("codex");
    promptMocks.select.mockResolvedValueOnce("custom");
    promptMocks.text.mockResolvedValueOnce("http://localhost:11434");
    promptMocks.select.mockResolvedValueOnce("openai");

    const answer = await askChoice({ offerToRemember: false });

    expect(discoveryMocks.discoverModelIds).not.toHaveBeenCalled();
    expect(answer.choice.customModel).toBeUndefined();
  });
});

describe("the Pi custom-target model step", () => {
  it.each(["openai", "anthropic", "raw"] as const)(
    "discovers models for the %s custom renderer too, unlike OpenCode",
    async (renderer) => {
      customPiAnswers(renderer);
      discoveryMocks.discoverModelIds.mockResolvedValue(["qwen3:8b"]);
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

      const answer = await askChoice({ offerToRemember: false });

      expect(discoveryMocks.discoverModelIds).toHaveBeenCalledWith(
        "http://localhost:11434"
      );
      expect(answer.choice.customModel).toBe("qwen3:8b");
      log.mockRestore();
    }
  );

  it("offers discovered models and keeps manual entry as the final option", async () => {
    customPiAnswers("openai");
    discoveryMocks.discoverModelIds.mockResolvedValue([
      "qwen3:8b",
      "deepseek-r1",
    ]);
    promptMocks.select.mockImplementationOnce(async (options) => {
      expect(
        options.options.map((option: { label: string }) => option.label)
      ).toEqual(["qwen3:8b", "deepseek-r1", "Enter a model ID manually"]);
      return options.options[0].value;
    });

    const answer = await askChoice({ offerToRemember: false });

    expect(answer.choice.customModel).toBe("qwen3:8b");
  });

  it("uses the only discovered model without asking", async () => {
    customPiAnswers("anthropic");
    discoveryMocks.discoverModelIds.mockResolvedValue(["llama3.1:8b"]);
    // Three prior selects only: agent, "custom", renderer. A fourth select
    // call here would mean the model step asked anyway.
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const answer = await askChoice({ offerToRemember: false });

    expect(promptMocks.select).toHaveBeenCalledTimes(3);
    expect(answer.choice.customModel).toBe("llama3.1:8b");
    log.mockRestore();
  });

  it("warns and immediately requires manual entry when discovery returns no IDs", async () => {
    customPiAnswers("openai");
    discoveryMocks.discoverModelIds.mockResolvedValue([]);
    const warning = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    promptMocks.text.mockResolvedValueOnce("fallback-model");

    const answer = await askChoice({ offerToRemember: false });

    expect(warning).toHaveBeenCalledWith(expect.stringContaining("model"));
    expect(answer.choice.customModel).toBe("fallback-model");
    warning.mockRestore();
  });

  it("does not discover models when Pi is not on a custom target", async () => {
    promptMocks.select.mockResolvedValueOnce("pi");
    promptMocks.select.mockResolvedValueOnce("anthropic");

    const answer = await askChoice({ offerToRemember: false });

    expect(discoveryMocks.discoverModelIds).not.toHaveBeenCalled();
    expect(answer.choice.customModel).toBeUndefined();
  });
});
