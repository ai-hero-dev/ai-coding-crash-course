import { describe, it, expect } from "vitest";
import {
  listAgents,
  listProviders,
  resolveChoice,
  shouldLogRequest,
} from "./agents";

const PORT = { port: 8787 };

/** Resolve, and fail loudly if the answer was not a usable target. */
function target(agent: string, provider?: string) {
  const result = resolveChoice({ agent, provider }, PORT);
  if (result.kind !== "target") {
    throw new Error(
      `expected a target for ${agent}/${provider}, got ${result.kind}`
    );
  }
  return result;
}

describe("listAgents", () => {
  it("offers the agents in popularity order", () => {
    expect(listAgents().map((agent) => agent.id)).toEqual([
      "claude-code",
      "codex",
      "copilot",
      "cursor",
      "opencode",
      "pi",
      "gemini",
      "amp",
    ]);
  });

  it("marks Cursor as unsupported", () => {
    const cursor = listAgents().find((agent) => agent.id === "cursor");
    expect(cursor?.supported).toBe(false);
  });

  it("marks Claude Code as supported", () => {
    const claude = listAgents().find((agent) => agent.id === "claude-code");
    expect(claude?.supported).toBe(true);
  });

  it("says Claude Code needs no provider question", () => {
    const claude = listAgents().find((agent) => agent.id === "claude-code");
    expect(claude?.needsProvider).toBe(false);
  });

  it("says OpenCode needs a provider question", () => {
    const opencode = listAgents().find((agent) => agent.id === "opencode");
    expect(opencode?.needsProvider).toBe(true);
  });
});

describe("listProviders", () => {
  it("returns nothing for an agent with one provider", () => {
    expect(listProviders("claude-code")).toEqual([]);
  });

  it("returns nothing for a refused agent", () => {
    expect(listProviders("cursor")).toEqual([]);
  });

  it("returns both OpenCode providers", () => {
    expect(listProviders("opencode").map((p) => p.id)).toEqual([
      "anthropic",
      "openai",
    ]);
  });

  it("returns all three Pi providers", () => {
    expect(listProviders("pi").map((p) => p.id)).toEqual([
      "anthropic",
      "openai",
      "codex",
    ]);
  });

  it("leads Pi with the Anthropic route, which is the simplest", () => {
    expect(listProviders("pi")[0].id).toBe("anthropic");
  });
});

describe("resolveChoice — upstream hosts", () => {
  it("sends Claude Code to Anthropic", () => {
    expect(target("claude-code").upstreamHost).toBe("api.anthropic.com");
  });

  it("sends Codex to OpenAI", () => {
    expect(target("codex").upstreamHost).toBe("api.openai.com");
  });

  it("sends Copilot to its own host", () => {
    expect(target("copilot").upstreamHost).toBe("api.githubcopilot.com");
  });

  it("sends OpenCode on Anthropic to Anthropic", () => {
    expect(target("opencode", "anthropic").upstreamHost).toBe("api.anthropic.com");
  });

  it("sends OpenCode on OpenAI to OpenAI", () => {
    expect(target("opencode", "openai").upstreamHost).toBe("api.openai.com");
  });

  it("sends Pi on Anthropic to Anthropic", () => {
    expect(target("pi", "anthropic").upstreamHost).toBe("api.anthropic.com");
  });

  it("sends Pi on OpenAI to OpenAI", () => {
    expect(target("pi", "openai").upstreamHost).toBe("api.openai.com");
  });

  it("sends Pi on a ChatGPT subscription to the ChatGPT host", () => {
    expect(target("pi", "codex").upstreamHost).toBe("chatgpt.com");
  });

  it("does not send Pi on a ChatGPT subscription to the OpenAI host", () => {
    expect(target("pi", "codex").upstreamHost).not.toBe("api.openai.com");
  });

  it("sends Gemini on an API key to the public API host", () => {
    expect(target("gemini", "api-key").upstreamHost).toBe(
      "generativelanguage.googleapis.com"
    );
  });

  it("sends Gemini on a Google login to the Code Assist host", () => {
    expect(target("gemini", "google-login").upstreamHost).toBe(
      "cloudcode-pa.googleapis.com"
    );
  });

  it("gives the two Gemini routes different hosts", () => {
    expect(target("gemini", "api-key").upstreamHost).not.toBe(
      target("gemini", "google-login").upstreamHost
    );
  });
});

describe("resolveChoice — renderers", () => {
  it("reads Claude Code with the Anthropic renderer", () => {
    expect(target("claude-code").renderer).toBe("anthropic");
  });

  it("reads Codex with the OpenAI renderer", () => {
    expect(target("codex").renderer).toBe("openai");
  });

  it("reads Copilot with the OpenAI renderer", () => {
    expect(target("copilot").renderer).toBe("openai");
  });

  it("reads OpenCode on Anthropic with the Anthropic renderer", () => {
    expect(target("opencode", "anthropic").renderer).toBe("anthropic");
  });

  it("reads OpenCode on OpenAI with the OpenAI renderer", () => {
    expect(target("opencode", "openai").renderer).toBe("openai");
  });

  it("reads Pi on a ChatGPT subscription with the OpenAI renderer", () => {
    expect(target("pi", "codex").renderer).toBe("openai");
  });

  it("reads both Gemini routes with the Gemini renderer", () => {
    expect(target("gemini", "api-key").renderer).toBe("gemini");
    expect(target("gemini", "google-login").renderer).toBe("gemini");
  });
});

describe("resolveChoice — base URLs", () => {
  it("gives OpenCode the /v1 suffix its SDK needs", () => {
    expect(target("opencode", "anthropic").baseUrl).toBe(
      "http://localhost:8787/v1"
    );
  });

  it("gives Claude Code no suffix, because it appends the whole path itself", () => {
    expect(target("claude-code").baseUrl).toBe("http://localhost:8787");
  });

  it("gives Copilot no suffix", () => {
    expect(target("copilot").baseUrl).toBe("http://localhost:8787");
  });

  it("gives Pi on Anthropic no suffix, because Pi's SDK adds /v1/messages", () => {
    expect(target("pi", "anthropic").baseUrl).toBe("http://localhost:8787");
  });

  it("gives Pi on OpenAI the /v1 suffix, because that SDK adds only /responses", () => {
    expect(target("pi", "openai").baseUrl).toBe("http://localhost:8787/v1");
  });

  it("gives Pi on a ChatGPT subscription the /backend-api suffix", () => {
    // Pi appends /codex/responses itself, and the real endpoint sits under
    // /backend-api. Without the suffix the forwarded path loses that segment.
    expect(target("pi", "codex").baseUrl).toBe("http://localhost:8787/backend-api");
  });

  it("uses the port it is given", () => {
    const result = resolveChoice({ agent: "claude-code" }, { port: 9000 });
    expect(result.kind === "target" && result.baseUrl).toBe(
      "http://localhost:9000"
    );
  });

  it("puts the chosen port into the command", () => {
    const result = resolveChoice({ agent: "claude-code" }, { port: 9000 });
    expect(result.kind === "target" && result.command).toContain(
      "http://localhost:9000"
    );
  });
});

describe("resolveChoice — commands", () => {
  it("turns tool search back on for Claude Code", () => {
    expect(target("claude-code").command).toContain("ENABLE_TOOL_SEARCH=true");
  });

  it("uses the plain variable name, not the prefixed one", () => {
    expect(target("claude-code").command).not.toContain(
      "CLAUDE_CODE_ENABLE_TOOL_SEARCH"
    );
  });

  it("sets the base URL for Claude Code", () => {
    expect(target("claude-code").command).toBe(
      "ANTHROPIC_BASE_URL=http://localhost:8787 ENABLE_TOOL_SEARCH=true claude"
    );
  });

  it("sets the base URL for Codex", () => {
    expect(target("codex").command).toBe(
      "OPENAI_BASE_URL=http://localhost:8787 codex"
    );
  });

  it("uses Copilot's own variable", () => {
    expect(target("copilot").command).toContain("COPILOT_API_URL=");
  });

  it("keeps Copilot's built-in MCP chatter out of the logs", () => {
    expect(target("copilot").command).toContain("--disable-builtin-mcps");
  });

  it("carries the suffix through into the OpenCode command", () => {
    expect(target("opencode", "anthropic").command).toBe(
      "ANTHROPIC_BASE_URL=http://localhost:8787/v1 opencode"
    );
  });

  it("uses the Code Assist variable for a Gemini Google login", () => {
    expect(target("gemini", "google-login").command).toBe(
      "CODE_ASSIST_ENDPOINT=http://localhost:8787 gemini"
    );
  });

  it("uses the other variable for a Gemini API key", () => {
    expect(target("gemini", "api-key").command).toBe(
      "GOOGLE_GEMINI_BASE_URL=http://localhost:8787 gemini"
    );
  });

  it("does not mix the two Gemini variables", () => {
    expect(target("gemini", "api-key").command).not.toContain(
      "CODE_ASSIST_ENDPOINT"
    );
    expect(target("gemini", "google-login").command).not.toContain(
      "GOOGLE_GEMINI_BASE_URL"
    );
  });

  it("gives Pi a bare command, because Pi has no base URL variable", () => {
    expect(target("pi", "anthropic").command).toBe("pi");
  });
});

describe("resolveChoice — setup files", () => {
  it("gives OpenCode a config file as the durable option", () => {
    expect(target("opencode", "anthropic").setup[0].path).toBe(
      "~/.config/opencode/opencode.json"
    );
  });

  it("puts the suffixed base URL into the OpenCode config file", () => {
    expect(target("opencode", "anthropic").setup[0].body).toContain(
      '"baseURL": "http://localhost:8787/v1"'
    );
  });

  it("leaves other placeholders in the OpenCode config alone", () => {
    expect(target("opencode", "anthropic").setup[0].body).toContain(
      "{env:ANTHROPIC_API_KEY}"
    );
  });

  it("gives Claude Code no config file to write", () => {
    expect(target("claude-code").setup).toEqual([]);
  });

  it("gives Pi its models file, because Pi has no variable to set", () => {
    expect(target("pi", "anthropic").setup[0].path).toBe("~/.pi/agent/models.json");
  });

  it("uses Pi's exact spelling of the base URL key", () => {
    expect(target("pi", "anthropic").setup[0].body).toContain('"baseUrl"');
    expect(target("pi", "anthropic").setup[0].body).not.toContain('"baseURL"');
  });

  it("names Pi's Anthropic provider", () => {
    expect(target("pi", "anthropic").setup[0].body).toContain('"anthropic"');
  });

  it("names Pi's Codex provider with its hyphenated id", () => {
    expect(target("pi", "codex").setup[0].body).toContain('"openai-codex"');
  });

  it("gives Pi on a ChatGPT subscription a second file for the transport", () => {
    const files = target("pi", "codex").setup;
    expect(files).toHaveLength(2);
    expect(files[1].path).toBe("~/.pi/agent/settings.json");
  });

  it("sets the SSE transport in that second file", () => {
    expect(target("pi", "codex").setup[1].body).toContain('"transport": "sse"');
  });

  it("does not put the transport in the models file, where Pi would ignore it", () => {
    expect(target("pi", "codex").setup[0].body).not.toContain("transport");
  });

  it("gives Pi on Anthropic only one file to write", () => {
    expect(target("pi", "anthropic").setup).toHaveLength(1);
  });
});

describe("resolveChoice — notes and warnings", () => {
  it("explains the tool search flag to a Claude Code student", () => {
    expect(target("claude-code").notes.join(" ")).toContain("ENABLE_TOOL_SEARCH");
  });

  it("warns a Codex student off the ChatGPT sign-in", () => {
    expect(target("codex").warnings.join(" ")).toContain("ChatGPT");
  });

  it("warns a Copilot student that some models write no log", () => {
    expect(target("copilot").warnings.join(" ")).toContain("WebSocket");
  });

  it("tells a Pi student on a ChatGPT subscription to use SSE", () => {
    expect(target("pi", "codex").notes.join(" ")).toContain("SSE");
  });

  it("tells a Pi student that the raw file keeps the compressed bytes", () => {
    expect(target("pi", "codex").notes.join(" ")).toContain(".request.txt");
  });

  it("warns a Gemini student that the two variables are not interchangeable", () => {
    expect(target("gemini", "api-key").warnings.join(" ")).toContain(
      "CODE_ASSIST_ENDPOINT"
    );
  });

  it("tells a Gemini student the Google login is free", () => {
    expect(target("gemini", "google-login").notes.join(" ")).toContain("free");
  });
});

describe("resolveChoice — refusals", () => {
  it("refuses Cursor", () => {
    expect(resolveChoice({ agent: "cursor" }, PORT).kind).toBe("refusal");
  });

  it("gives a reason for refusing Cursor", () => {
    const result = resolveChoice({ agent: "cursor" }, PORT);
    expect(result.kind === "refusal" && result.reason).toContain("own servers");
  });

  it("refuses Amp", () => {
    expect(resolveChoice({ agent: "amp" }, PORT).kind).toBe("refusal");
  });

  it("gives a reason for refusing Amp", () => {
    const result = resolveChoice({ agent: "amp" }, PORT);
    expect(result.kind === "refusal" && result.reason).toContain("own servers");
  });

  it("names the agent in the refusal", () => {
    const result = resolveChoice({ agent: "cursor" }, PORT);
    expect(result.kind === "refusal" && result.agentLabel).toBe("Cursor CLI");
  });

  it("gives no upstream host for a refused agent", () => {
    const result = resolveChoice({ agent: "cursor" }, PORT);
    expect(result).not.toHaveProperty("upstreamHost");
  });
});

describe("shouldLogRequest", () => {
  it("logs a real Anthropic turn", () => {
    expect(shouldLogRequest("POST", "/v1/messages?beta=true", "anthropic")).toBe(
      true
    );
  });

  it("drops Anthropic token counting", () => {
    expect(
      shouldLogRequest("POST", "/v1/messages/count_tokens", "anthropic")
    ).toBe(false);
  });

  it("drops a connectivity probe, which would write an empty document", () => {
    expect(shouldLogRequest("HEAD", "/api/hello", "anthropic")).toBe(false);
  });

  it("drops a GET, because a model call is always a POST", () => {
    expect(shouldLogRequest("GET", "/v1/models", "openai")).toBe(false);
  });

  it("ignores the case of the method", () => {
    expect(shouldLogRequest("post", "/v1/messages", "anthropic")).toBe(true);
  });

  it("logs a real OpenAI turn", () => {
    expect(shouldLogRequest("POST", "/v1/responses", "openai")).toBe(true);
  });

  it("logs a streaming Gemini turn", () => {
    expect(
      shouldLogRequest(
        "POST",
        "/v1beta/models/gemini-2.5-pro:streamGenerateContent",
        "gemini"
      )
    ).toBe(true);
  });

  it("logs a non-streaming Gemini turn", () => {
    expect(
      shouldLogRequest(
        "POST",
        "/v1beta/models/gemini-2.5-pro:generateContent",
        "gemini"
      )
    ).toBe(true);
  });

  it("drops Gemini token counting, which has its own name", () => {
    expect(
      shouldLogRequest("POST", "/v1beta/models/gemini-2.5-pro:countTokens", "gemini")
    ).toBe(false);
  });

  it("drops the Google login housekeeping calls, which carry no prompt", () => {
    expect(shouldLogRequest("POST", "/v1internal:loadCodeAssist", "gemini")).toBe(
      false
    );
    expect(shouldLogRequest("POST", "/v1internal:retrieveUserQuota", "gemini")).toBe(
      false
    );
    expect(shouldLogRequest("POST", "/v1internal:listExperiments", "gemini")).toBe(
      false
    );
    expect(
      shouldLogRequest("POST", "/v1internal:recordCodeAssistMetrics", "gemini")
    ).toBe(false);
  });
});

describe("resolveChoice — bad input", () => {
  it("rejects an unknown agent", () => {
    expect(resolveChoice({ agent: "nonesuch" }, PORT).kind).toBe("error");
  });

  it("lists the known agents when the agent is unknown", () => {
    const result = resolveChoice({ agent: "nonesuch" }, PORT);
    expect(result.kind === "error" && result.message).toContain("claude-code");
  });

  it("rejects a choice that omits a needed provider", () => {
    expect(resolveChoice({ agent: "opencode" }, PORT).kind).toBe("error");
  });

  it("lists the providers when one is missing", () => {
    const result = resolveChoice({ agent: "opencode" }, PORT);
    expect(result.kind === "error" && result.message).toContain("anthropic");
  });

  it("rejects an unknown provider", () => {
    expect(resolveChoice({ agent: "opencode", provider: "cohere" }, PORT).kind).toBe(
      "error"
    );
  });

  it("accepts a single-provider agent with no provider given", () => {
    expect(resolveChoice({ agent: "claude-code" }, PORT).kind).toBe("target");
  });

  it("ignores a stale provider on a single-provider agent", () => {
    expect(target("claude-code", "whatever").upstreamHost).toBe(
      "api.anthropic.com"
    );
  });

  it("points the student at --force when a choice cannot be resolved", () => {
    const result = resolveChoice({ agent: "nonesuch" }, PORT);
    expect(result.kind === "error" && result.message).toContain("--force");
  });
});
