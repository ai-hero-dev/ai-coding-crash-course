/**
 * agents.ts — the catalogue of coding agents the request-logger can proxy.
 *
 * This module is the single source of truth for every per-agent fact:
 *  - which upstream host that agent's traffic must go to,
 *  - which renderer reads that wire format,
 *  - the exact command to run, correct by construction.
 *
 * Nothing else in the tool decides these things. The wizard reads the catalogue
 * to build its questions, the proxy reads the resolved target to route and to
 * render, and the startup banner prints the resolved command. Because the facts
 * are data rather than prose, they can be tested — and they cannot silently rot
 * the way a README does.
 *
 * Adding an eighth agent should be one entry here and nothing else.
 */

export type RendererId = "anthropic" | "openai" | "gemini";

/** What the student picked. This, and only this, is what gets saved to disk. */
export interface AgentChoice {
  agent: string;
  provider?: string;
}

export interface ResolvedTarget {
  kind: "target";
  agent: string;
  agentLabel: string;
  provider: string;
  providerLabel: string;
  /** The single host every request is forwarded to. */
  upstreamHost: string;
  renderer: RendererId;
  /** The base URL the student points their agent at, e.g. http://localhost:8787/v1 */
  baseUrl: string;
  /** The copy-pasteable command, complete with env vars and flags. */
  command: string;
  /** Config files the student must write before the command will work. */
  setup: SetupFile[];
  /** Things worth knowing. Printed under the command. */
  notes: string[];
  /** Things that will otherwise look like the tool is broken. */
  warnings: string[];
}

export interface AgentRefusal {
  kind: "refusal";
  agent: string;
  agentLabel: string;
  reason: string;
}

export interface ResolveError {
  kind: "error";
  message: string;
}

export type Resolution = ResolvedTarget | AgentRefusal | ResolveError;

export interface SetupFile {
  path: string;
  body: string;
  language: string;
}

// ---------------------------------------------------------------------------
// Catalogue
// ---------------------------------------------------------------------------

interface ProviderEntry {
  id: string;
  label: string;
  upstreamHost: string;
  renderer: RendererId;
  /**
   * Appended to http://localhost:PORT to make the base URL.
   *
   * Per-agent, never global. OpenCode's SDK appends `/messages` to whatever it
   * is given, so it needs `/v1`. Aider's layer appends the whole path, so it
   * must not have one. Getting this wrong produces a 404 the student cannot
   * explain, so it is data, and it is tested.
   */
  suffix?: string;
  /** Environment variables, in the order they should appear in the command. */
  env?: Array<[string, string]>;
  bin: string;
  args?: string[];
  setup?: SetupFile[];
  notes?: string[];
  warnings?: string[];
}

interface AgentEntry {
  id: string;
  label: string;
  /** A supported agent has providers. A refused one has a reason. */
  providers?: ProviderEntry[];
  reason?: string;
}

/**
 * Codex has no base URL environment variable. OPENAI_BASE_URL was read by older
 * versions and is gone from 0.133.0, so a student following an older guide gets
 * an empty logs folder and no error. The `-c` flag sets one config key for one
 * run, which is why it is used here in place of editing a file.
 */
const CODEX_OVERRIDE_NOTE =
  "The -c flag sets this for one run only. Your ~/.codex/config.toml is not " +
  "touched, so your normal Codex is unchanged the moment you stop using this " +
  "command. Keep the quotes exactly as they are: Codex reads the value as TOML, " +
  "and an unquoted URL does not parse.";

const PI_NOTE =
  "Pi has no base URL variable and no flag. A config file is the only way to " +
  "point it at this tool. Overriding the provider keeps Pi's whole built-in " +
  "model list, so you do not have to list the models yourself.";

/**
 * Pi's provider override file. The key is `baseUrl`, in this exact spelling.
 * Pi accepts other spellings into the file and then refuses to start, so this
 * is worth getting right for the student.
 */
function piModels(providerId: string, baseUrl: string): SetupFile {
  return {
    path: "~/.pi/agent/models.json",
    language: "json",
    body: [
      "{",
      '  "providers": {',
      `    "${providerId}": {`,
      `      "baseUrl": "${baseUrl}"`,
      "    }",
      "  }",
      "}",
    ].join("\n"),
  };
}

const OPENCODE_NOTE =
  "The environment variable above works, but only by accident: OpenCode passes " +
  "no base URL of its own for this provider, so the bundled SDK falls back to " +
  "reading the variable. The config file below is the durable way to do it.";

/**
 * Ordered by popularity, decided 2026-08-06. The wizard shows them in this
 * order, so a student is most likely to find theirs first.
 */
const AGENTS: AgentEntry[] = [
  {
    id: "claude-code",
    label: "Claude Code",
    providers: [
      {
        id: "anthropic",
        label: "Anthropic",
        upstreamHost: "api.anthropic.com",
        renderer: "anthropic",
        env: [
          ["ANTHROPIC_BASE_URL", "{baseUrl}"],
          ["ENABLE_TOOL_SEARCH", "true"],
        ],
        bin: "claude",
        notes: [
          "ENABLE_TOOL_SEARCH=true is important. Claude Code trusts one host only. " +
            "When the base URL points somewhere else, it turns off tool search, stops " +
            "deferring tools, and writes every tool schema into the request. Your " +
            "capture is then larger than a real one and has a different shape. The " +
            "flag turns that effect off, so what you read is what Claude Code really sends.",
          "This works with a Claude subscription login. Your login stays active. " +
            "Only the model traffic moves.",
        ],
      },
    ],
  },
  {
    id: "codex",
    label: "Codex",
    providers: [
      {
        id: "chatgpt",
        label: "ChatGPT subscription",
        upstreamHost: "chatgpt.com",
        renderer: "openai",
        // Codex joins the base URL and the word `responses` with one slash, so
        // the base URL must carry the whole prefix that it would otherwise use,
        // which is https://chatgpt.com/backend-api/codex.
        suffix: "/backend-api/codex",
        bin: "codex",
        args: ["-c", `'openai_base_url="{baseUrl}"'`],
        notes: [CODEX_OVERRIDE_NOTE],
      },
      {
        id: "openai",
        label: "OpenAI API key",
        upstreamHost: "api.openai.com",
        renderer: "openai",
        // The API key route defaults to https://api.openai.com/v1, and Codex
        // appends `responses` to it, so the base URL keeps the /v1.
        suffix: "/v1",
        bin: "codex",
        args: ["-c", `'openai_base_url="{baseUrl}"'`],
        notes: [CODEX_OVERRIDE_NOTE],
      },
    ],
  },
  {
    id: "copilot",
    label: "GitHub Copilot CLI",
    providers: [
      {
        id: "github",
        label: "GitHub subscription",
        upstreamHost: "api.githubcopilot.com",
        renderer: "openai",
        env: [["COPILOT_API_URL", "{baseUrl}"]],
        bin: "copilot",
        notes: [
          "Your normal Copilot subscription login is enough. You do not need an " +
            "API key. Sign-in traffic still goes to github.com. Only the model " +
            "traffic moves.",
          "Copilot's built-in MCP servers add their tools to every request, and " +
            "they make calls of their own, so you get more documents than turns " +
            "you typed. That is what your agent really sends, so it is worth " +
            "reading once. If you want a smaller capture, add " +
            "--disable-builtin-mcps to the command.",
        ],
        warnings: [
          "Some models negotiate a WebSocket transport. This tool cannot see a " +
            "WebSocket, so those turns write no log at all. If your logs folder " +
            "stays empty, try a different model. gpt-5.1 used plain HTTP in testing.",
        ],
      },
    ],
  },
  {
    id: "cursor",
    label: "Cursor CLI",
    reason:
      "Cursor builds its system prompt on its own servers. The request that " +
      "leaves your machine holds your message and very little else, so there is " +
      "no system prompt and no tool list for this tool to show you. No proxy can " +
      "read what your machine never sends. Search the whole shipped Cursor " +
      "bundle and you will find no system prompt text and no tool schemas.",
  },
  {
    id: "opencode",
    label: "OpenCode",
    providers: [
      {
        id: "anthropic",
        label: "Anthropic",
        upstreamHost: "api.anthropic.com",
        renderer: "anthropic",
        suffix: "/v1",
        env: [["ANTHROPIC_BASE_URL", "{baseUrl}"]],
        bin: "opencode",
        setup: [
          {
            path: "~/.config/opencode/opencode.json",
            language: "json",
            body: [
              "{",
              '  "$schema": "https://opencode.ai/config.json",',
              '  "model": "anthropic/claude-sonnet-4-5",',
              '  "small_model": "anthropic/claude-sonnet-4-5",',
              '  "provider": {',
              '    "anthropic": {',
              '      "options": {',
              '        "apiKey": "{env:ANTHROPIC_API_KEY}",',
              '        "baseURL": "{baseUrl}"',
              "      }",
              "    }",
              "  }",
              "}",
            ].join("\n"),
          },
        ],
        notes: [
          OPENCODE_NOTE,
          "OpenCode never counts tokens. Instead it makes a second call with its " +
            "small model to title the thread, so one turn writes exactly two captures.",
        ],
      },
      {
        id: "openai",
        label: "OpenAI API key",
        upstreamHost: "api.openai.com",
        renderer: "openai",
        suffix: "/v1",
        env: [["OPENAI_BASE_URL", "{baseUrl}"]],
        bin: "opencode",
        setup: [
          {
            path: "~/.config/opencode/opencode.json",
            language: "json",
            body: [
              "{",
              '  "$schema": "https://opencode.ai/config.json",',
              '  "model": "openai/gpt-5.1",',
              '  "small_model": "openai/gpt-5.1",',
              '  "provider": {',
              '    "openai": {',
              '      "options": {',
              '        "apiKey": "{env:OPENAI_API_KEY}",',
              '        "baseURL": "{baseUrl}"',
              "      }",
              "    }",
              "  }",
              "}",
            ].join("\n"),
          },
        ],
        notes: [
          OPENCODE_NOTE,
          "OpenCode uses a different system prompt for each provider. Run it once " +
            "against Anthropic and once against OpenAI and compare the two captures.",
        ],
        warnings: [
          "A ChatGPT login will not work here. OpenCode sends that traffic to a " +
            "different host on purpose, so it goes around this tool. Use an " +
            "OpenAI API key.",
        ],
      },
    ],
  },
  {
    id: "pi",
    label: "Pi",
    providers: [
      {
        id: "anthropic",
        label: "Anthropic",
        upstreamHost: "api.anthropic.com",
        renderer: "anthropic",
        bin: "pi",
        setup: [piModels("anthropic", "{baseUrl}")],
        notes: [
          PI_NOTE,
          "This route works with an Anthropic API key and with a Claude " +
            "subscription login.",
          "Pi never counts tokens, so every file in your logs folder is a real turn.",
        ],
      },
      {
        id: "openai",
        label: "OpenAI API key",
        upstreamHost: "api.openai.com",
        renderer: "openai",
        // Pi hands this to the OpenAI SDK, which appends `/responses`.
        suffix: "/v1",
        bin: "pi",
        setup: [piModels("openai", "{baseUrl}")],
        notes: [PI_NOTE],
      },
      {
        id: "codex",
        label: "ChatGPT subscription (Codex)",
        upstreamHost: "chatgpt.com",
        renderer: "openai",
        // Pi appends `/codex/responses` itself, and the real endpoint lives
        // under `/backend-api`. Without this suffix the forwarded path would be
        // missing that segment and the request would fail.
        suffix: "/backend-api",
        bin: "pi",
        setup: [
          piModels("openai-codex", "{baseUrl}"),
          {
            path: "~/.pi/agent/settings.json",
            language: "json",
            body: ['{', '  "transport": "sse"', "}"].join("\n"),
          },
        ],
        notes: [
          PI_NOTE,
          "The SSE transport is not optional on this route. Pi's default tries " +
            "a WebSocket first, and this tool cannot see a WebSocket. The " +
            "setting goes in the settings file, not in the models file. Pi " +
            "accepts it in the models file and then quietly ignores it.",
          "Pi compresses the request body on this route. The readable .md file " +
            "shows the decoded body. The .request.txt file keeps the compressed " +
            "bytes exactly as sent, so you can still replay it.",
        ],
      },
    ],
  },
  {
    id: "gemini",
    label: "Gemini CLI",
    providers: [
      {
        id: "google-login",
        label: "Free Google account login",
        upstreamHost: "cloudcode-pa.googleapis.com",
        renderer: "gemini",
        env: [["CODE_ASSIST_ENDPOINT", "{baseUrl}"]],
        bin: "gemini",
        notes: [
          "This is the free tier. You do not need to buy anything to finish the lesson.",
          "On this route Gemini also makes several housekeeping calls that carry no " +
            "prompt. This tool forwards them but does not log them, so your logs " +
            "folder holds real turns only.",
        ],
      },
      {
        id: "api-key",
        label: "Gemini API key",
        upstreamHost: "generativelanguage.googleapis.com",
        renderer: "gemini",
        env: [["GOOGLE_GEMINI_BASE_URL", "{baseUrl}"]],
        bin: "gemini",
        warnings: [
          "The two Gemini routes use different variables and they are not " +
            "interchangeable. GOOGLE_GEMINI_BASE_URL is ignored under a Google " +
            "account login, and CODE_ASSIST_ENDPOINT is ignored under an API key. " +
            "Neither one gives you an error. You just get an empty logs folder.",
        ],
      },
    ],
  },
  {
    id: "amp",
    label: "Amp",
    reason:
      "Amp builds its system prompt on its own servers, the same as Cursor. " +
      "Amp does have a URL setting, but it points at Amp's own server, not at " +
      "the model endpoint, so it cannot help you here.",
  },
];

// ---------------------------------------------------------------------------
// Reading the catalogue
// ---------------------------------------------------------------------------

export interface AgentSummary {
  id: string;
  label: string;
  supported: boolean;
  /** True when the student must also be asked which model provider they use. */
  needsProvider: boolean;
}

export interface ProviderSummary {
  id: string;
  label: string;
}

/**
 * Every agent the wizard offers, in the order it offers them.
 *
 * The catalogue is written in order of popularity. The list is then sorted so
 * the agents that cannot be logged sit at the bottom, because a student picking
 * from the top should meet the ones that work first. The sort is stable, so
 * popularity still decides the order inside each group.
 */
export function listAgents(): AgentSummary[] {
  const summaries = AGENTS.map((agent) => ({
    id: agent.id,
    label: agent.label,
    supported: agent.providers != null,
    needsProvider: (agent.providers?.length ?? 0) > 1,
  }));
  return [
    ...summaries.filter((agent) => agent.supported),
    ...summaries.filter((agent) => !agent.supported),
  ];
}

/** The providers to ask about for one agent. Empty when there is nothing to ask. */
export function listProviders(agentId: string): ProviderSummary[] {
  const agent = AGENTS.find((a) => a.id === agentId);
  if (!agent?.providers || agent.providers.length < 2) return [];
  return agent.providers.map((p) => ({ id: p.id, label: p.label }));
}

// ---------------------------------------------------------------------------
// Which requests are worth writing down
// ---------------------------------------------------------------------------

/**
 * Some calls reach the model provider but never produce a model reply. One turn
 * fires several of them, so they are noise for "what is sent to the model". The
 * proxy forwards them all. It only writes down the ones this returns true for.
 *
 *  - A model call is always a POST. Agents also send connectivity probes, which
 *    would otherwise write an empty document at the top of the logs folder.
 *  - Anthropic counts tokens with a `count_tokens` path.
 *  - Gemini counts tokens under a different name, and on the Google login route
 *    it fires several calls that carry no prompt at all. On that route the only
 *    calls worth keeping are the ones that generate content.
 */
export function shouldLogRequest(
  method: string,
  reqPath: string,
  renderer: RendererId
): boolean {
  if (method.toUpperCase() !== "POST") return false;
  // Case-insensitive on purpose: the streaming call is `:streamGenerateContent`,
  // with a capital G, and the non-streaming one is `:generateContent`.
  if (renderer === "gemini") return /generateContent/i.test(reqPath);
  return !reqPath.includes("count_tokens");
}

// ---------------------------------------------------------------------------
// Resolution — the seam
// ---------------------------------------------------------------------------

function buildCommand(provider: ProviderEntry, baseUrl: string): string {
  const fill = (text: string) => text.replace(/\{baseUrl\}/g, baseUrl);
  const env = (provider.env ?? []).map(([key, value]) => `${key}=${fill(value)}`);
  // Arguments take the base URL too. Codex has no variable for it, so its
  // whole override arrives as a flag.
  const args = (provider.args ?? []).map(fill);
  return [...env, provider.bin, ...args].join(" ");
}

/**
 * Turn a saved choice into everything the tool needs, or into a clear reason
 * why it cannot.
 *
 * Pure: no disk, no network, no clock. Give it the same choice and the same
 * port and it gives back the same answer.
 */
export function resolveChoice(
  choice: AgentChoice,
  options: { port: number }
): Resolution {
  const agent = AGENTS.find((a) => a.id === choice.agent);

  if (!agent) {
    return {
      kind: "error",
      message:
        `Unknown agent "${choice.agent}". Run with --force to choose again. ` +
        `Known agents: ${AGENTS.map((a) => a.id).join(", ")}.`,
    };
  }

  if (!agent.providers) {
    return {
      kind: "refusal",
      agent: agent.id,
      agentLabel: agent.label,
      reason: agent.reason ?? "This agent cannot be logged.",
    };
  }

  let provider: ProviderEntry | undefined;
  if (agent.providers.length === 1) {
    // One provider, so the wizard never asked. Ignore anything saved.
    provider = agent.providers[0];
  } else if (choice.provider == null) {
    return {
      kind: "error",
      message:
        `${agent.label} can drive more than one model provider, so a provider ` +
        `must be chosen. Run with --force to choose again. Providers: ` +
        `${agent.providers.map((p) => p.id).join(", ")}.`,
    };
  } else {
    provider = agent.providers.find((p) => p.id === choice.provider);
    if (!provider) {
      return {
        kind: "error",
        message:
          `Unknown provider "${choice.provider}" for ${agent.label}. Run with ` +
          `--force to choose again. Providers: ` +
          `${agent.providers.map((p) => p.id).join(", ")}.`,
      };
    }
  }

  const baseUrl = `http://localhost:${options.port}${provider.suffix ?? ""}`;

  return {
    kind: "target",
    agent: agent.id,
    agentLabel: agent.label,
    provider: provider.id,
    providerLabel: provider.label,
    upstreamHost: provider.upstreamHost,
    renderer: provider.renderer,
    baseUrl,
    command: buildCommand(provider, baseUrl),
    setup: (provider.setup ?? []).map((file) => ({
      ...file,
      body: file.body.replace(/\{baseUrl\}/g, baseUrl),
    })),
    notes: provider.notes ?? [],
    warnings: provider.warnings ?? [],
  };
}
