import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import {
  agentProviders,
  CUSTOM_ID,
  customTargetNeedsModel,
  ISSUE_URL,
  listAgents,
  listProviders,
  OTHER_ID,
  resolveChoice,
  shouldLogRequest,
  type AgentChoice,
} from "./agents";

const PORT = { port: 8787, platform: "linux" as NodeJS.Platform };

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

/** Resolve a custom-base-url choice, and fail loudly if it was not a usable target. */
function customTarget(choice: AgentChoice) {
  const result = resolveChoice(choice, PORT);
  if (result.kind !== "custom-target") {
    throw new Error(`expected a custom-target, got ${result.kind}`);
  }
  return result;
}

describe('resolveChoice — "Other"', () => {
  it("asks for the missing agent instead of failing", () => {
    const result = resolveChoice({ agent: OTHER_ID }, PORT);
    expect(result.kind).toBe("request");
  });

  it("asks for the missing provider of an agent it knows", () => {
    const result = resolveChoice({ agent: "codex", provider: OTHER_ID }, PORT);
    expect(result.kind).toBe("request");
  });

  it("names the agent when the student named one", () => {
    const result = resolveChoice({ agent: "codex", provider: OTHER_ID }, PORT);
    if (result.kind !== "request") throw new Error("expected a request");
    expect(result.agentLabel).toBe("Codex");
  });

  it("names no agent when the agent itself was the missing one", () => {
    const result = resolveChoice({ agent: OTHER_ID }, PORT);
    if (result.kind !== "request") throw new Error("expected a request");
    expect(result.agentLabel).toBeNull();
  });

  it("sends the student to the issue tracker", () => {
    const result = resolveChoice({ agent: OTHER_ID }, PORT);
    if (result.kind !== "request") throw new Error("expected a request");
    expect(result.url).toBe(ISSUE_URL);
    expect(result.url).toContain("/issues/new");
  });

  it("never offers Other as an agent in the catalogue", () => {
    // The wizard adds it to the question. It is not an agent, so it must not
    // appear in the list the catalogue publishes.
    expect(listAgents().map((agent) => agent.id)).not.toContain(OTHER_ID);
    expect(listProviders("codex").map((p) => p.id)).not.toContain(OTHER_ID);
  });
});

describe("listAgents", () => {
  it("offers the agents in popularity order, refused ones last", () => {
    expect(listAgents().map((agent) => agent.id)).toEqual([
      "claude-code",
      "codex",
      "copilot",
      "opencode",
      "pi",
      "omp",
      "gemini",
      "junie",
      "cursor",
      "amp",
    ]);
  });

  it("puts every agent that can be logged above every agent that cannot", () => {
    const supported = listAgents().map((agent) => agent.supported);
    expect(supported.indexOf(false)).toBeGreaterThan(
      supported.lastIndexOf(true)
    );
  });

  it("marks Cursor as unsupported", () => {
    const cursor = listAgents().find((agent) => agent.id === "cursor");
    expect(cursor?.supported).toBe(false);
  });

  it("marks Claude Code as supported", () => {
    const claude = listAgents().find((agent) => agent.id === "claude-code");
    expect(claude?.supported).toBe(true);
  });

  it("says Claude Code needs a provider question now it has Vertex AI too", () => {
    const claude = listAgents().find((agent) => agent.id === "claude-code");
    expect(claude?.needsProvider).toBe(true);
  });

  it("says OpenCode needs a provider question", () => {
    const opencode = listAgents().find((agent) => agent.id === "opencode");
    expect(opencode?.needsProvider).toBe(true);
  });

  it("marks OMP as supported", () => {
    const omp = listAgents().find((agent) => agent.id === "omp");
    expect(omp?.supported).toBe(true);
  });

  it("marks OMP as always custom", () => {
    const omp = listAgents().find((agent) => agent.id === "omp");
    expect(omp?.alwaysCustom).toBe(true);
  });

  it("says no other agent is always custom", () => {
    const others = listAgents().filter(
      (agent) => agent.id !== "omp" && agent.id !== "junie"
    );
    expect(others.every((agent) => agent.alwaysCustom === false)).toBe(true);
  });

  it("says OMP needs no provider question, because it never shows one", () => {
    const omp = listAgents().find((agent) => agent.id === "omp");
    expect(omp?.needsProvider).toBe(false);
  });

  it("marks Junie as supported and always custom", () => {
    const junie = listAgents().find((agent) => agent.id === "junie");
    expect(junie?.supported).toBe(true);
    expect(junie?.alwaysCustom).toBe(true);
  });

  it("says Junie needs no provider question either, even though it has two internal templates", () => {
    // Junie is the first alwaysCustom agent with more than one catalogue
    // provider (see findCustomTemplate) — needsProvider must stay false
    // regardless, because askChoice skips the provider question for any
    // alwaysCustom agent before providers.length is ever consulted.
    const junie = listAgents().find((agent) => agent.id === "junie");
    expect(junie?.needsProvider).toBe(false);
  });
});

describe("listProviders", () => {
  it("returns nothing for an agent with one provider", () => {
    expect(listProviders("copilot")).toEqual([]);
  });

  it("returns nothing for a refused agent", () => {
    expect(listProviders("cursor")).toEqual([]);
  });

  it("returns both Claude Code providers", () => {
    expect(listProviders("claude-code").map((p) => p.id)).toEqual([
      "anthropic",
      "vertex",
    ]);
  });

  it("leads Claude Code with the Anthropic route, which is the simplest", () => {
    expect(listProviders("claude-code")[0].id).toBe("anthropic");
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

describe("agentProviders", () => {
  it("returns the one provider a single-provider agent has, unlike listProviders", () => {
    expect(listProviders("copilot")).toEqual([]);
    expect(agentProviders("copilot").map((p) => p.id)).toEqual(["github"]);
  });

  it("returns nothing for a refused agent", () => {
    expect(agentProviders("cursor")).toEqual([]);
  });

  it("returns OMP's one internal template provider, even though the wizard never shows it", () => {
    // config.ts never calls agentProviders for an alwaysCustom agent — see
    // askChoice — but the entry exists to hold the command/setup template
    // resolveCustomTarget borrows from, so it is not empty here.
    expect(agentProviders("omp").map((p) => p.id)).toEqual([CUSTOM_ID]);
  });

  it("agrees with listProviders once there are two or more", () => {
    expect(agentProviders("opencode").map((p) => p.id)).toEqual(
      listProviders("opencode").map((p) => p.id)
    );
  });

  it("returns Junie's two internal template providers, even though the wizard never shows them", () => {
    // Same reasoning as OMP above, except Junie has two templates to pick
    // between (see findCustomTemplate) rather than one.
    expect(agentProviders("junie").map((p) => p.id)).toEqual([
      "anthropic",
      "openai",
    ]);
  });
});

describe("resolveChoice — upstream hosts", () => {
  it("sends Claude Code to Anthropic", () => {
    expect(target("claude-code", "anthropic").upstreamHost).toBe(
      "api.anthropic.com"
    );
  });

  it("sends Claude Code on Vertex AI to the global Vertex endpoint", () => {
    expect(target("claude-code", "vertex").upstreamHost).toBe(
      "aiplatform.googleapis.com"
    );
  });

  it("gives Claude Code's two providers different hosts", () => {
    expect(target("claude-code", "anthropic").upstreamHost).not.toBe(
      target("claude-code", "vertex").upstreamHost
    );
  });

  it("sends Codex on an API key to OpenAI", () => {
    expect(target("codex", "openai").upstreamHost).toBe("api.openai.com");
  });

  it("sends Codex on a ChatGPT subscription to chatgpt.com", () => {
    expect(target("codex", "chatgpt").upstreamHost).toBe("chatgpt.com");
  });

  it("sends Copilot to its own host", () => {
    expect(target("copilot").upstreamHost).toBe("api.githubcopilot.com");
  });

  it("sends OpenCode on Anthropic to Anthropic", () => {
    expect(target("opencode", "anthropic").upstreamHost).toBe(
      "api.anthropic.com"
    );
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
    expect(target("claude-code", "anthropic").renderer).toBe("anthropic");
  });

  it("reads Claude Code on Vertex AI with the Anthropic renderer too, since Vertex's Claude endpoint is the same Messages API shape", () => {
    expect(target("claude-code", "vertex").renderer).toBe("anthropic");
  });

  it("reads Codex with the OpenAI renderer", () => {
    expect(target("codex", "openai").renderer).toBe("openai");
    expect(target("codex", "chatgpt").renderer).toBe("openai");
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
    expect(target("claude-code", "anthropic").baseUrl).toBe(
      "http://localhost:8787"
    );
  });

  it("gives Claude Code on Vertex AI no suffix either, for the same reason", () => {
    expect(target("claude-code", "vertex").baseUrl).toBe(
      "http://localhost:8787"
    );
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
    expect(target("pi", "codex").baseUrl).toBe(
      "http://localhost:8787/backend-api"
    );
  });

  it("uses the port it is given", () => {
    const result = resolveChoice(
      { agent: "claude-code", provider: "anthropic" },
      { port: 9000, platform: "linux" }
    );
    expect(result.kind === "target" && result.baseUrl).toBe(
      "http://localhost:9000"
    );
  });

  it("puts the chosen port into the command", () => {
    const result = resolveChoice(
      { agent: "claude-code", provider: "anthropic" },
      { port: 9000, platform: "linux" }
    );
    expect(result.kind === "target" && result.command).toContain(
      "http://localhost:9000"
    );
  });
});

describe("resolveChoice — commands", () => {
  it("turns tool search back on for Claude Code", () => {
    expect(target("claude-code", "anthropic").command).toContain(
      "ENABLE_TOOL_SEARCH=true"
    );
  });

  it("uses the plain variable name, not the prefixed one", () => {
    expect(target("claude-code", "anthropic").command).not.toContain(
      "CLAUDE_CODE_ENABLE_TOOL_SEARCH"
    );
  });

  it("sets the base URL for Claude Code", () => {
    expect(target("claude-code", "anthropic").command).toBe(
      "ANTHROPIC_BASE_URL=http://localhost:8787 ENABLE_TOOL_SEARCH=true claude"
    );
  });

  it("sets the Vertex base URL variable for Claude Code on Vertex AI, not the plain Anthropic one", () => {
    // ANTHROPIC_BASE_URL is silently ignored once Claude Code is in Vertex
    // mode (CLAUDE_CODE_USE_VERTEX=1) — this is the whole reason the two
    // providers need different env vars.
    expect(target("claude-code", "vertex").command).toBe(
      "ANTHROPIC_VERTEX_BASE_URL=http://localhost:8787 ENABLE_TOOL_SEARCH=true claude"
    );
  });

  it("never puts the plain Anthropic variable in the Vertex command", () => {
    expect(target("claude-code", "vertex").command).not.toContain(
      "ANTHROPIC_BASE_URL=http://localhost:8787 "
    );
  });

  it("sets the base URL for Codex on an API key", () => {
    // Codex 0.133.0 has no OPENAI_BASE_URL. The flag is the only door.
    expect(target("codex", "openai").command).toBe(
      `codex -c 'openai_base_url="http://localhost:8787/v1"'`
    );
  });

  it("sets the base URL for Codex on a ChatGPT subscription", () => {
    expect(target("codex", "chatgpt").command).toBe(
      `codex -c 'openai_base_url="http://localhost:8787/backend-api/codex"'`
    );
  });

  it("never tells a Codex student to use the variable that was removed", () => {
    expect(target("codex", "openai").command).not.toContain("OPENAI_BASE_URL");
    expect(target("codex", "chatgpt").command).not.toContain("OPENAI_BASE_URL");
  });

  it("uses Copilot's own variable", () => {
    expect(target("copilot").command).toContain("COPILOT_API_URL=");
  });

  it("does not change how a Copilot student runs their agent", () => {
    // The built-in MCP servers are part of what Copilot really sends. Turning
    // them off would make the capture tidier and less true.
    expect(target("copilot").command).toBe(
      "COPILOT_API_URL=http://localhost:8787 copilot"
    );
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

describe("resolveChoice — commands on win32", () => {
  // A student on native Windows (not WSL, not Git Bash) has no shell that
  // understands `KEY=value bin` — PowerShell reports it as an unrecognized
  // command, which is exactly the report that prompted this. PowerShell's
  // own syntax is one `$env:KEY = 'value'` statement per variable, chained
  // with semicolons.
  const WIN = { port: 8787, platform: "win32" as NodeJS.Platform };

  function winTarget(agent: string, provider?: string) {
    const result = resolveChoice({ agent, provider }, WIN);
    if (result.kind !== "target") {
      throw new Error(
        `expected a target for ${agent}/${provider}, got ${result.kind}`
      );
    }
    return result;
  }

  it("uses PowerShell $env: syntax instead of POSIX VAR=value", () => {
    expect(winTarget("claude-code", "anthropic").command).toBe(
      "$env:ANTHROPIC_BASE_URL = 'http://localhost:8787'; " +
        "$env:ENABLE_TOOL_SEARCH = 'true'; claude"
    );
  });

  it("never prints the POSIX VAR=value form on win32", () => {
    expect(winTarget("claude-code", "anthropic").command).not.toMatch(
      /^ANTHROPIC_BASE_URL=/
    );
  });

  it("uses PowerShell $env: syntax for Claude Code on Vertex AI too", () => {
    expect(winTarget("claude-code", "vertex").command).toBe(
      "$env:ANTHROPIC_VERTEX_BASE_URL = 'http://localhost:8787'; " +
        "$env:ENABLE_TOOL_SEARCH = 'true'; claude"
    );
  });

  it("chains one assignment per variable with semicolons", () => {
    expect(winTarget("copilot").command).toBe(
      "$env:COPILOT_API_URL = 'http://localhost:8787'; copilot"
    );
  });

  it("leaves a command with no env vars unchanged, since there is nothing to rewrite", () => {
    // Pi has no base URL variable at all.
    expect(winTarget("pi", "anthropic").command).toBe("pi");
  });

  it("leaves Codex's flag-based override unchanged", () => {
    // Codex has no env var override — its whole command is a `-c` flag,
    // single-quoted. PowerShell parses a single-quoted literal the same way
    // bash does (no interpolation), so this needs no rewriting.
    expect(winTarget("codex", "openai").command).toBe(
      `codex -c 'openai_base_url="http://localhost:8787/v1"'`
    );
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
    expect(target("claude-code", "anthropic").setup).toEqual([]);
  });

  it("gives Claude Code on Vertex AI no config file either — it's all env vars", () => {
    expect(target("claude-code", "vertex").setup).toEqual([]);
  });

  it("gives Pi its models file, because Pi has no variable to set", () => {
    expect(target("pi", "anthropic").setup[0].path).toBe(
      "~/.pi/agent/models.json"
    );
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
    expect(target("claude-code", "anthropic").notes.join(" ")).toContain(
      "ENABLE_TOOL_SEARCH"
    );
  });

  it("tells a Vertex AI student that ANTHROPIC_BASE_URL is ignored in Vertex mode", () => {
    const notes = target("claude-code", "vertex").notes.join(" ");
    expect(notes).toContain("ANTHROPIC_VERTEX_BASE_URL");
    expect(notes).toContain("ANTHROPIC_BASE_URL");
    expect(notes).toContain("silently ignored");
  });

  it("tells a Vertex AI student this entry only covers the global region", () => {
    expect(target("claude-code", "vertex").notes.join(" ")).toContain(
      "CLOUD_ML_REGION=global"
    );
  });

  it("tells a Codex student the flag does not touch their config file", () => {
    expect(target("codex", "openai").notes.join(" ")).toContain("config.toml");
  });

  it("tells a Copilot student where the extra documents come from", () => {
    expect(target("copilot").notes.join(" ")).toContain("MCP");
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
    expect(
      shouldLogRequest("POST", "/v1/messages?beta=true", "anthropic")
    ).toBe(true);
  });

  it("drops Anthropic token counting", () => {
    expect(
      shouldLogRequest("POST", "/v1/messages/count_tokens", "anthropic")
    ).toBe(false);
  });

  it("logs a real Claude Code on Vertex AI turn", () => {
    expect(
      shouldLogRequest(
        "POST",
        "/v1/projects/my-proj/locations/global/publishers/anthropic/models/claude-sonnet-4-5:streamRawPredict",
        "anthropic"
      )
    ).toBe(true);
  });

  it("drops Vertex AI token counting, which uses countTokens instead of count_tokens", () => {
    expect(
      shouldLogRequest(
        "POST",
        "/v1/projects/my-proj/locations/global/publishers/anthropic/models/claude-sonnet-4-5:countTokens",
        "anthropic"
      )
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
      shouldLogRequest(
        "POST",
        "/v1beta/models/gemini-2.5-pro:countTokens",
        "gemini"
      )
    ).toBe(false);
  });

  it("drops the Google login housekeeping calls, which carry no prompt", () => {
    expect(
      shouldLogRequest("POST", "/v1internal:loadCodeAssist", "gemini")
    ).toBe(false);
    expect(
      shouldLogRequest("POST", "/v1internal:retrieveUserQuota", "gemini")
    ).toBe(false);
    expect(
      shouldLogRequest("POST", "/v1internal:listExperiments", "gemini")
    ).toBe(false);
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
    expect(
      resolveChoice({ agent: "opencode", provider: "cohere" }, PORT).kind
    ).toBe("error");
  });

  it("accepts a single-provider agent with no provider given", () => {
    // Claude Code no longer qualifies now it has two providers (see below) —
    // Copilot is still single-provider and exercises this general case.
    expect(resolveChoice({ agent: "copilot" }, PORT).kind).toBe("target");
  });

  it("ignores a stale provider on a single-provider agent", () => {
    expect(target("copilot", "whatever").upstreamHost).toBe(
      "api.githubcopilot.com"
    );
  });

  it("now requires a provider for Claude Code, since it has two", () => {
    const result = resolveChoice({ agent: "claude-code" }, PORT);
    expect(result.kind).toBe("error");
    expect(result.kind === "error" && result.message).toContain("vertex");
  });

  it("points the student at --force when a choice cannot be resolved", () => {
    const result = resolveChoice({ agent: "nonesuch" }, PORT);
    expect(result.kind === "error" && result.message).toContain("--force");
  });
});

// ---------------------------------------------------------------------------
// Custom base URL — resolving a target the catalogue does not know about
// ---------------------------------------------------------------------------

describe("resolveChoice — custom base URL", () => {
  it("resolves a valid http:// target", () => {
    const result = customTarget({
      agent: "opencode",
      provider: CUSTOM_ID,
      customBaseUrl: "http://localhost:11434",
      customRenderer: "openai",
      customModel: "test-model",
    });
    expect(result.upstreamBaseUrl).toBe("http://localhost:11434");
  });

  it("resolves a valid https:// target", () => {
    const result = customTarget({
      agent: "opencode",
      provider: CUSTOM_ID,
      customBaseUrl: "https://api.deepseek.com",
      customRenderer: "openai",
      customModel: "test-model",
    });
    expect(result.upstreamBaseUrl).toBe("https://api.deepseek.com");
  });

  it("strips a path from the typed base URL, the same way the catalogue keeps a bare host", () => {
    const result = customTarget({
      agent: "opencode",
      provider: CUSTOM_ID,
      customBaseUrl: "https://api.deepseek.com/v1/some/path",
      customRenderer: "openai",
      customModel: "test-model",
    });
    expect(result.upstreamBaseUrl).toBe("https://api.deepseek.com");
  });

  it("rejects a base URL with no scheme", () => {
    const result = resolveChoice(
      {
        agent: "opencode",
        provider: CUSTOM_ID,
        customBaseUrl: "localhost:11434",
      },
      PORT
    );
    expect(result.kind).toBe("error");
  });

  it("rejects a base URL that is not a URL at all", () => {
    const result = resolveChoice(
      { agent: "opencode", provider: CUSTOM_ID, customBaseUrl: "not a url" },
      PORT
    );
    expect(result.kind).toBe("error");
  });

  it("rejects a base URL with an unrelated scheme", () => {
    const result = resolveChoice(
      {
        agent: "opencode",
        provider: CUSTOM_ID,
        customBaseUrl: "ftp://example.com",
      },
      PORT
    );
    expect(result.kind).toBe("error");
  });

  it("names the base URL in the rejection", () => {
    const result = resolveChoice(
      { agent: "opencode", provider: CUSTOM_ID, customBaseUrl: "not a url" },
      PORT
    );
    expect(result.kind === "error" && result.message).toContain("not a url");
  });

  it("points the student at --force when the base URL cannot be resolved", () => {
    const result = resolveChoice(
      { agent: "opencode", provider: CUSTOM_ID, customBaseUrl: "not a url" },
      PORT
    );
    expect(result.kind === "error" && result.message).toContain("--force");
  });

  it("rejects a custom choice with no base URL at all", () => {
    const result = resolveChoice(
      { agent: "opencode", provider: CUSTOM_ID },
      PORT
    );
    expect(result.kind).toBe("error");
  });

  it("defaults to the raw renderer when no wire format was given", () => {
    const result = customTarget({
      agent: "opencode",
      provider: CUSTOM_ID,
      customBaseUrl: "http://localhost:11434",
    });
    expect(result.renderer).toBe("raw");
  });

  it("uses the openai renderer when that wire format is chosen", () => {
    expect(
      customTarget({
        agent: "opencode",
        provider: CUSTOM_ID,
        customBaseUrl: "http://localhost:11434",
        customRenderer: "openai",
        customModel: "test-model",
      }).renderer
    ).toBe("openai");
  });

  it("uses the anthropic renderer when that wire format is chosen", () => {
    expect(
      customTarget({
        agent: "opencode",
        provider: CUSTOM_ID,
        customBaseUrl: "http://localhost:11434",
        customRenderer: "anthropic",
      }).renderer
    ).toBe("anthropic");
  });

  it("uses the raw renderer when the student says they are not sure", () => {
    expect(
      customTarget({
        agent: "opencode",
        provider: CUSTOM_ID,
        customBaseUrl: "http://localhost:11434",
        customRenderer: "raw",
      }).renderer
    ).toBe("raw");
  });

  it("warns the student that a raw capture is a JSON dump, not a broken one", () => {
    const result = customTarget({
      agent: "opencode",
      provider: CUSTOM_ID,
      customBaseUrl: "http://localhost:11434",
      customRenderer: "raw",
    });
    expect(result.notes.join(" ")).toContain("not broken");
  });

  it("labels a custom target's provider as Custom base URL", () => {
    expect(
      customTarget({
        agent: "opencode",
        provider: CUSTOM_ID,
        customBaseUrl: "http://localhost:11434",
        customRenderer: "openai",
        customModel: "test-model",
      }).providerLabel
    ).toBe("Custom base URL");
  });

  it("has no catalogue provider id at all", () => {
    const result = customTarget({
      agent: "opencode",
      provider: CUSTOM_ID,
      customBaseUrl: "http://localhost:11434",
      customRenderer: "openai",
      customModel: "test-model",
    });
    expect(result).not.toHaveProperty("provider");
  });
});

describe("resolveChoice — custom base URL, per-agent command template", () => {
  it("builds a one-run OpenCode provider config for the OpenAI-compatible route", () => {
    const result = customTarget({
      agent: "opencode",
      provider: CUSTOM_ID,
      customBaseUrl: "http://localhost:11434",
      customRenderer: "openai",
      customModel: "qwen3:8b",
    });
    const assignment = result.command.slice(0, -" opencode".length);
    const serialized = execFileSync(
      "/bin/sh",
      [
        "-c",
        `${assignment} node -e 'process.stdout.write(process.env.OPENCODE_CONFIG_CONTENT)'`,
      ],
      { encoding: "utf8" }
    );
    const config = JSON.parse(serialized);

    expect(config.provider["request-logger"]).toEqual({
      npm: "@ai-sdk/openai-compatible",
      name: "Request Logger",
      options: { baseURL: "http://localhost:8787/v1" },
      models: { "qwen3:8b": { name: "qwen3:8b" } },
    });
    expect(config.model).toBe("request-logger/qwen3:8b");
    expect(config.small_model).toBe("request-logger/qwen3:8b");
    expect(result.setup).toEqual([]);
  });

  it("shell-quotes a model ID containing quotes and metacharacters", () => {
    const model = `model ' "$HOME"; printf INJECTED`;
    const result = customTarget({
      agent: "opencode",
      provider: CUSTOM_ID,
      customBaseUrl: "http://localhost:11434",
      customRenderer: "openai",
      customModel: model,
    });
    const assignment = result.command.slice(0, -" opencode".length);
    const serialized = execFileSync(
      "/bin/sh",
      [
        "-c",
        `${assignment} node -e 'process.stdout.write(process.env.OPENCODE_CONFIG_CONTENT)'`,
      ],
      { encoding: "utf8" }
    );
    const config = JSON.parse(serialized);

    expect(config.model).toBe(`request-logger/${model}`);
    expect(config.provider["request-logger"].models).toEqual({
      [model]: { name: model },
    });
  });

  it("requires a remembered model for specialized OpenCode custom targets", () => {
    const result = resolveChoice(
      {
        agent: "opencode",
        provider: CUSTOM_ID,
        customBaseUrl: "http://localhost:11434",
        customRenderer: "openai",
      },
      PORT
    );
    expect(result.kind).toBe("error");
    expect(result.kind === "error" && result.message).toContain("--force");
  });

  it("borrows OpenCode's Anthropic env var and config file for an anthropic-compatible custom target", () => {
    // The env var and the config file both point the agent at the proxy's own
    // address (http://localhost:8787), not at the upstream the student typed
    // — same as every catalogue target. See upstreamBaseUrl for the upstream.
    const result = customTarget({
      agent: "opencode",
      provider: CUSTOM_ID,
      customBaseUrl: "http://localhost:11434",
      customRenderer: "anthropic",
    });
    expect(result.command).toContain(
      "ANTHROPIC_BASE_URL=http://localhost:8787/v1"
    );
    expect(result.setup[0].path).toBe("~/.config/opencode/opencode.json");
    expect(result.upstreamBaseUrl).toBe("http://localhost:11434");
  });

  it("uses PowerShell syntax for a borrowed-template custom target on win32", () => {
    const result = resolveChoice(
      {
        agent: "opencode",
        provider: CUSTOM_ID,
        customBaseUrl: "http://localhost:11434",
        customRenderer: "anthropic",
      },
      { port: 8787, platform: "win32" }
    );
    if (result.kind !== "custom-target") {
      throw new Error(`expected a custom-target, got ${result.kind}`);
    }
    expect(result.command).toBe(
      "$env:ANTHROPIC_BASE_URL = 'http://localhost:8787/v1'; opencode"
    );
  });

  it("uses OpenCode's temporary config for an openai-compatible custom target", () => {
    const result = customTarget({
      agent: "opencode",
      provider: CUSTOM_ID,
      customBaseUrl: "http://localhost:11434",
      customRenderer: "openai",
      customModel: "test-model",
    });
    expect(result.command).toContain("OPENCODE_CONFIG_CONTENT=");
    expect(result.setup).toEqual([]);
  });

  it("uses PowerShell syntax for OpenCode's temporary config on win32", () => {
    const result = resolveChoice(
      {
        agent: "opencode",
        provider: CUSTOM_ID,
        customBaseUrl: "http://localhost:11434",
        customRenderer: "openai",
        customModel: "test-model",
      },
      { port: 8787, platform: "win32" }
    );
    if (result.kind !== "custom-target") {
      throw new Error(`expected a custom-target, got ${result.kind}`);
    }
    expect(result.command.startsWith("$env:OPENCODE_CONFIG_CONTENT = '")).toBe(
      true
    );
    expect(result.command.endsWith("; opencode")).toBe(true);
    expect(result.command).not.toContain("OPENCODE_CONFIG_CONTENT=$env");
    expect(result.command).not.toMatch(/^OPENCODE_CONFIG_CONTENT=/);
  });

  it("doubles an embedded single quote in the PowerShell-quoted config, since PowerShell has no backslash escape", () => {
    const result = resolveChoice(
      {
        agent: "opencode",
        provider: CUSTOM_ID,
        customBaseUrl: "http://localhost:11434",
        customRenderer: "openai",
        customModel: `model's name`,
      },
      { port: 8787, platform: "win32" }
    );
    if (result.kind !== "custom-target") {
      throw new Error(`expected a custom-target, got ${result.kind}`);
    }
    expect(result.command).toContain("model''s name");
  });

  it("defaults OpenCode's raw/not-sure custom target to the OpenAI template", () => {
    const result = customTarget({
      agent: "opencode",
      provider: CUSTOM_ID,
      customBaseUrl: "http://localhost:11434",
      customRenderer: "raw",
    });
    expect(result.command).toContain("OPENAI_BASE_URL=");
  });

  it("borrows Pi's OpenAI provider key for an openai-compatible custom target", () => {
    const result = customTarget({
      agent: "pi",
      provider: CUSTOM_ID,
      customBaseUrl: "http://localhost:11434",
      customRenderer: "openai",
      customModel: "qwen3:8b",
    });
    expect(result.setup[0].body).toContain('"openai"');
    expect(result.setup[0].body).not.toContain('"openai-codex"');
  });

  it("never borrows Pi's ChatGPT-subscription template for a custom target", () => {
    const result = customTarget({
      agent: "pi",
      provider: CUSTOM_ID,
      customBaseUrl: "http://localhost:11434",
      customRenderer: "openai",
      customModel: "qwen3:8b",
    });
    expect(result.setup).toHaveLength(1);
  });

  it("requires a remembered model for every Pi custom target, not just one wire format", () => {
    for (const customRenderer of ["openai", "anthropic", "raw"] as const) {
      const result = resolveChoice(
        {
          agent: "pi",
          provider: CUSTOM_ID,
          customBaseUrl: "http://localhost:11434",
          customRenderer,
        },
        PORT
      );
      expect(result.kind).toBe("error");
      expect(result.kind === "error" && result.message).toContain("--force");
    }
  });

  it("writes the selected model into Pi's models file, replacing its built-in catalogue", () => {
    const result = customTarget({
      agent: "pi",
      provider: CUSTOM_ID,
      customBaseUrl: "http://localhost:11434",
      customRenderer: "openai",
      customModel: "qwen3:8b",
    });
    const written = JSON.parse(result.setup[0].body);
    expect(written.providers.openai).toEqual({
      baseUrl: "http://localhost:8787/v1",
      models: [{ id: "qwen3:8b" }],
    });
  });

  it("writes Pi's Anthropic provider key for an anthropic-compatible custom target, with the selected model", () => {
    const result = customTarget({
      agent: "pi",
      provider: CUSTOM_ID,
      customBaseUrl: "http://localhost:11434",
      customRenderer: "anthropic",
      customModel: "llama3.1:8b",
    });
    const written = JSON.parse(result.setup[0].body);
    expect(written.providers.anthropic).toEqual({
      baseUrl: "http://localhost:8787",
      models: [{ id: "llama3.1:8b" }],
    });
  });

  it("warns an Anthropic-compatible Pi custom target that discovery may find nothing, since /v1/models is OpenAI-shaped", () => {
    const result = customTarget({
      agent: "pi",
      provider: CUSTOM_ID,
      customBaseUrl: "http://localhost:11434",
      customRenderer: "anthropic",
      customModel: "llama3.1:8b",
    });
    expect(result.notes.join(" ")).toContain("/v1/models");
  });

  it("gives an openai-compatible Pi custom target no discovery caveat, since that is exactly what discovery checks", () => {
    const result = customTarget({
      agent: "pi",
      provider: CUSTOM_ID,
      customBaseUrl: "http://localhost:11434",
      customRenderer: "openai",
      customModel: "qwen3:8b",
    });
    expect(result.notes.join(" ")).not.toContain("/v1/models");
  });

  it("gives Pi a bare command for a custom target too, since Pi has no base URL variable", () => {
    const result = customTarget({
      agent: "pi",
      provider: CUSTOM_ID,
      customBaseUrl: "http://localhost:11434",
      customRenderer: "openai",
      customModel: "qwen3:8b",
    });
    expect(result.command).toBe("pi");
  });

  it("does not carry Pi's built-in-catalogue note into a custom target, since that note is no longer true there", () => {
    const result = customTarget({
      agent: "pi",
      provider: CUSTOM_ID,
      customBaseUrl: "http://localhost:11434",
      customRenderer: "openai",
      customModel: "qwen3:8b",
    });
    expect(result.notes.join(" ")).not.toContain("whole built-in model list");
  });

  it("reuses Claude Code's Anthropic template regardless of the wire format chosen, since that provider is tagged as the catch-all", () => {
    // Claude Code now has two providers (anthropic, vertex), so this no
    // longer falls out of findCustomTemplate's single-provider shortcut —
    // it works because the "anthropic" provider is tagged
    // customTemplateFor: ["anthropic", "openai", "raw"]. "vertex" is
    // untagged on purpose: it needs Google Cloud auth, so it would silently
    // misconfigure an unrelated custom server.
    const result = customTarget({
      agent: "claude-code",
      provider: CUSTOM_ID,
      customBaseUrl: "http://localhost:11434",
      customRenderer: "raw",
    });
    expect(result.command).toContain(
      "ANTHROPIC_BASE_URL=http://localhost:8787"
    );
    expect(result.command).toContain("claude");
    expect(result.upstreamBaseUrl).toBe("http://localhost:11434");
  });

  it("reuses Copilot's own template regardless of the wire format chosen, since it has only one", () => {
    const result = customTarget({
      agent: "copilot",
      provider: CUSTOM_ID,
      customBaseUrl: "http://localhost:11434",
      customRenderer: "anthropic",
    });
    expect(result.command).toContain("COPILOT_API_URL=http://localhost:8787");
  });

  it("never borrows Codex's ChatGPT-subscription template for a custom target", () => {
    const result = customTarget({
      agent: "codex",
      provider: CUSTOM_ID,
      customBaseUrl: "http://localhost:11434",
      customRenderer: "openai",
    });
    expect(result.command).not.toContain("/backend-api/codex");
    expect(result.baseUrl).toBe("http://localhost:8787/v1");
  });
});

describe("customTargetNeedsModel", () => {
  it("needs a model for Pi on every wire format", () => {
    expect(customTargetNeedsModel("pi", "openai")).toBe(true);
    expect(customTargetNeedsModel("pi", "anthropic")).toBe(true);
    expect(customTargetNeedsModel("pi", "raw")).toBe(true);
  });

  it("needs a model for OpenCode only on the OpenAI-compatible wire format", () => {
    expect(customTargetNeedsModel("opencode", "openai")).toBe(true);
    expect(customTargetNeedsModel("opencode", "anthropic")).toBe(false);
    expect(customTargetNeedsModel("opencode", "raw")).toBe(false);
  });

  it("needs no model for any other agent, on any wire format", () => {
    for (const renderer of ["openai", "anthropic", "raw"] as const) {
      expect(customTargetNeedsModel("codex", renderer)).toBe(false);
      expect(customTargetNeedsModel("claude-code", renderer)).toBe(false);
      expect(customTargetNeedsModel("omp", renderer)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// OMP — every setup is custom
// ---------------------------------------------------------------------------

describe("resolveChoice — OMP", () => {
  it("resolves OMP straight from a base URL and wire format, with no provider needed", () => {
    const result = resolveChoice(
      {
        agent: "omp",
        customBaseUrl: "http://localhost:8787",
        customRenderer: "openai",
      },
      PORT
    );
    expect(result.kind).toBe("custom-target");
  });

  it("gives OMP its own bin, with no env vars", () => {
    const result = customTarget({
      agent: "omp",
      customBaseUrl: "http://localhost:11434",
      customRenderer: "raw",
    });
    expect(result.command).toBe("omp");
  });

  it("gives OMP its YAML models file under ~/.omp/agent/models.yml", () => {
    const result = customTarget({
      agent: "omp",
      customBaseUrl: "http://localhost:11434",
      customRenderer: "raw",
    });
    expect(result.setup).toHaveLength(1);
    expect(result.setup[0].path).toBe("~/.omp/agent/models.yml");
    expect(result.setup[0].language).toBe("yaml");
  });

  it("puts the resolved base URL under a provider key in the YAML file", () => {
    const result = customTarget({
      agent: "omp",
      customBaseUrl: "http://localhost:11434",
      customRenderer: "raw",
    });
    expect(result.setup[0].body).toContain('baseUrl: "http://localhost:8787"');
    expect(result.setup[0].body).toContain("providers:");
  });

  it("still resolves OMP even when the saved provider field is stale", () => {
    // alwaysCustom agents ignore whatever is saved under `provider`; only the
    // custom base URL and renderer matter.
    const result = resolveChoice(
      {
        agent: "omp",
        provider: "whatever-was-saved-before",
        customBaseUrl: "http://localhost:11434",
        customRenderer: "raw",
      },
      PORT
    );
    expect(result.kind).toBe("custom-target");
  });

  it("rejects OMP with no base URL", () => {
    expect(resolveChoice({ agent: "omp" }, PORT).kind).toBe("error");
  });
});

// ---------------------------------------------------------------------------
// Junie — every setup is custom, and (unlike OMP) has two templates to pick
// between by wire format
// ---------------------------------------------------------------------------

describe("resolveChoice — Junie", () => {
  it("resolves Junie straight from a base URL, wire format and model, with no provider needed", () => {
    const result = resolveChoice(
      {
        agent: "junie",
        customBaseUrl: "http://localhost:8787",
        customRenderer: "anthropic",
        customModel: "claude-sonnet-4-5",
      },
      PORT
    );
    expect(result.kind).toBe("custom-target");
  });

  it("tells Junie which custom model to use, with the endpoint path folded into the base URL", () => {
    const result = customTarget({
      agent: "junie",
      customBaseUrl: "http://localhost:11434",
      customRenderer: "anthropic",
      customModel: "claude-sonnet-4-5",
    });
    expect(result.command).toBe("junie --model custom:request-logger");
    expect(result.baseUrl).toBe("http://localhost:8787/v1/messages");
  });

  it("uses the OpenAI chat/completions path for the openai-compatible route", () => {
    const result = customTarget({
      agent: "junie",
      customBaseUrl: "http://localhost:11434",
      customRenderer: "openai",
      customModel: "gpt-4.1",
    });
    expect(result.baseUrl).toBe("http://localhost:8787/v1/chat/completions");
  });

  it("writes an Anthropic model profile for the anthropic-compatible route", () => {
    const result = customTarget({
      agent: "junie",
      customBaseUrl: "http://localhost:11434",
      customRenderer: "anthropic",
      customModel: "claude-sonnet-4-5",
    });
    expect(result.setup).toHaveLength(1);
    expect(result.setup[0].path).toBe("~/.junie/models/request-logger.json");
    expect(result.setup[0].language).toBe("json");
    expect(result.setup[0].body).toContain('"apiType": "Anthropic"');
    expect(result.setup[0].body).toContain(
      '"baseUrl": "http://localhost:8787/v1/messages"'
    );
    expect(result.setup[0].body).toContain('"x-api-key":');
  });

  it("writes the chosen model into the profile's id field, since Junie sends it verbatim as the model on every request", () => {
    // An earlier version hard-coded "id" to "request-logger", which is not a
    // real model on any backend -- Anthropic rejected it with a 404 ("model:
    // request-logger"), confirmed against a live proxy.
    const result = customTarget({
      agent: "junie",
      customBaseUrl: "http://localhost:11434",
      customRenderer: "anthropic",
      customModel: "claude-sonnet-4-5",
    });
    expect(result.setup[0].body).toContain('"id": "claude-sonnet-4-5"');
    expect(result.setup[0].body).not.toContain("request-logger");
  });

  it("rejects a Junie custom target with no model chosen", () => {
    const result = resolveChoice(
      {
        agent: "junie",
        customBaseUrl: "http://localhost:11434",
        customRenderer: "anthropic",
      },
      PORT
    );
    expect(result.kind).toBe("error");
  });

  it("does not set anthropic-version itself, since Junie already sends one", () => {
    // Junie's Anthropic client always sends its own anthropic-version
    // header. An extraHeaders entry with the same name does not replace
    // that, it is appended as a second occurrence, and the two get joined
    // with a comma on the wire (e.g. "2023-06-01,2023-06-01") -- which
    // Anthropic rejects as an invalid version code. Confirmed against a
    // live proxy: this is what was producing a 400 on every request.
    const result = customTarget({
      agent: "junie",
      customBaseUrl: "http://localhost:11434",
      customRenderer: "anthropic",
      customModel: "claude-sonnet-4-5",
    });
    expect(result.setup[0].body).not.toContain("anthropic-version");
  });

  it("writes an OpenAICompletion model profile for the openai-compatible route", () => {
    const result = customTarget({
      agent: "junie",
      customBaseUrl: "http://localhost:11434",
      customRenderer: "openai",
      customModel: "gpt-4.1",
    });
    expect(result.setup[0].body).toContain('"apiType": "OpenAICompletion"');
    expect(result.setup[0].body).toContain('"Authorization": "Bearer');
  });

  it("defaults Junie's raw/not-sure custom target to the OpenAI-kind template", () => {
    // Same convention as OpenCode and Pi's custom targets: an unidentified
    // custom server is far more often OpenAI-compatible than
    // Anthropic-compatible.
    const result = customTarget({
      agent: "junie",
      customBaseUrl: "http://localhost:11434",
      customRenderer: "raw",
      customModel: "some-model",
    });
    expect(result.setup[0].body).toContain('"apiType": "OpenAICompletion"');
  });

  it("never sends Junie's Anthropic-kind api-key header on the OpenAI route, or vice versa", () => {
    const anthropicRoute = customTarget({
      agent: "junie",
      customBaseUrl: "http://localhost:11434",
      customRenderer: "anthropic",
      customModel: "claude-sonnet-4-5",
    });
    const openaiRoute = customTarget({
      agent: "junie",
      customBaseUrl: "http://localhost:11434",
      customRenderer: "openai",
      customModel: "gpt-4.1",
    });
    expect(anthropicRoute.setup[0].body).not.toContain('"Authorization":');
    expect(openaiRoute.setup[0].body).not.toContain('"x-api-key":');
  });

  it("warns that Junie's model profile bypasses JetBrains AI authentication, unlike every login-based agent here", () => {
    const result = customTarget({
      agent: "junie",
      customBaseUrl: "http://localhost:11434",
      customRenderer: "anthropic",
      customModel: "claude-sonnet-4-5",
    });
    expect(result.notes.some((note) => note.includes("bypasses"))).toBe(true);
  });

  it("warns that Junie's documented config.json proxy route does not actually work", () => {
    const result = customTarget({
      agent: "junie",
      customBaseUrl: "http://localhost:11434",
      customRenderer: "anthropic",
      customModel: "claude-sonnet-4-5",
    });
    expect(
      result.notes.some((note) => note.includes("never consulted"))
    ).toBe(true);
  });

  it("still resolves Junie even when the saved provider field is stale", () => {
    // alwaysCustom agents ignore whatever is saved under `provider`; only
    // the custom base URL, renderer and model matter.
    const result = resolveChoice(
      {
        agent: "junie",
        provider: "whatever-was-saved-before",
        customBaseUrl: "http://localhost:11434",
        customRenderer: "raw",
        customModel: "some-model",
      },
      PORT
    );
    expect(result.kind).toBe("custom-target");
  });

  it("rejects Junie with no base URL", () => {
    expect(resolveChoice({ agent: "junie" }, PORT).kind).toBe("error");
  });
});
