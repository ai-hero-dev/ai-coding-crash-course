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

/**
 * What the student picked. This, and only this, is what gets saved to disk.
 *
 * The local* fields exist only for a local (locally hosted) model. The wizard
 * fills them by probing the URL the student types in, so a plain resolveChoice
 * call with no localUrl on a local provider is an error, not a guess.
 */
export interface AgentChoice {
  agent: string;
  provider?: string;
  /** The address of the student's local model server, e.g. http://127.0.0.1:8000 */
  localUrl?: string;
  /** The model id the probe found, or the one the student picked. */
  localModel?: string;
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
  /** Scheme of the upstream. Always https for a cloud provider; http for a local server. */
  upstreamScheme: "http" | "https";
  /** Port of the upstream. 443 for a cloud provider; the server's port for a local one. */
  upstreamPort: number;
  /**
   * Path prepended to the received path before forwarding. Empty for a cloud
   * provider; the student's server subpath for a local one.
   */
  upstreamPrefix: string;
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

/**
 * The student's setup is not in the catalogue, and they said so.
 *
 * This is not an error. The catalogue is a list of what has been tested, not a
 * list of what is possible, so the only useful answer is to ask for the missing
 * entry. It is never saved.
 */
export interface SetupRequest {
  kind: "request";
  /** The agent, when the student named one the catalogue knows. */
  agentLabel: string | null;
  /** Where to ask for the missing entry. */
  url: string;
}

export type Resolution =
  | ResolvedTarget
  | AgentRefusal
  | ResolveError
  | SetupRequest;

/**
 * The last option in both questions.
 *
 * A student whose agent or provider is missing has nowhere to go otherwise.
 * They would either pick the nearest wrong thing and read a capture that is not
 * theirs, or quit. Both questions therefore end with this, and it leads to the
 * issue tracker.
 */
export const OTHER_ID = "other";
export const OTHER_LABEL = "Other, or not sure";
export const ISSUE_URL =
  "https://github.com/ai-hero-dev/ai-coding-crash-course/issues/new";

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
  /**
   * The host every request is forwarded to. For a local provider this is a
   * placeholder; the real host and port come from the student's URL at resolve
   * time, because they differ per machine.
   */
  upstreamHost: string;
  renderer: RendererId;
  /**
   * True when this provider points at a locally hosted model instead of a cloud
   * API. The student supplies the server's address; the tool probes it to learn
   * the wire format and a model to use.
   */
  local?: boolean;
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

/**
 * Oh My Pi's provider override file. Like Pi's, the key is `baseUrl`, in this
 * exact spelling. Overriding a built-in provider only moves its endpoint; the
 * whole built-in model list keeps working.
 */
function ompModels(providerId: string, baseUrl: string): SetupFile {
  return {
    path: "~/.omp/agent/models.yml",
    language: "yaml",
    body: ["providers:", `  ${providerId}:`, `    baseUrl: ${baseUrl}`]
      .join("\n"),
  };
}

/**
 * A locally hosted model server. The student gives the address of the server;
 * this tool sits between Oh My Pi and that server, and writes a readable
 * document for every request on the way through.
 *
 * Every server we target serves the OpenAI-compatible API under /v1, so this
 * route uses the same wire as the OpenAI route. The only difference is where
 * the upstream lives: on the student's machine, over plain http.
 */
const LOCAL_NOTE =
  "This route talks to a model running on your own machine instead of a " +
  "cloud API. The address is yours, and the model to use is picked from what " +
  "the server offers. No API key is needed: the server is on your own " +
  "network, and Oh My Pi is told not to send one. The command pins the main " +
  "model and the background model to it, so every call stays on your machine " +
  "and gets captured.";

/**
 * The parts the tool needs to dial the student's local server. Named rather
 * than inlined so the contract is importable by the proxy and the tests.
 */
export interface LocalUpstream {
  scheme: "http" | "https";
  host: string;
  port: number;
  /** Path prepended to received paths before forwarding; empty when none. */
  prefix: string;
}

/**
 * Split the student's local server URL into the parts the tool needs to
 * forward to it.
 *
 * Pure: no network, no clock. The same URL always gives the same answer. A
 * trailing /v1 is stripped, because the OpenAI-compatible API is always under
 * /v1 relative to the server's root, and the requests already carry it.
 */
export function localUpstream(url: string): LocalUpstream {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(
      `"${url}" is not a URL. Give the address of your local model server, ` +
        `such as http://127.0.0.1:8000.`
    );
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(
      `Your local model server must speak http or https. "${url}" does not.`
    );
  }
  const scheme = parsed.protocol.slice(0, -1) as "http" | "https";
  const host = parsed.hostname;
  if (!host) throw new Error(`"${url}" has no host.`);
  // A URL can leave the port implicit. Make it explicit, because the forwarder
  // dials the port on its own.
  const port = parsed.port ? Number(parsed.port) : scheme === "https" ? 443 : 80;
  let prefix = parsed.pathname.replace(/\/+$/, "");
  if (prefix.endsWith("/v1")) prefix = prefix.slice(0, -3);
  return { scheme, host, port, prefix };
}

/**
 * Oh My Pi's local model block. A provider that lists models is a full
 * provider, not an override, so it does not touch any of the built-in
 * providers. It is also the only way to name a model that is not in the
 * built-in list.
 *
 * `auth: none` tells Oh My Pi to send no key. `api: openai-completions` tells
 * it to call /chat/completions, the endpoint every local server serves.
 * `baseUrl` points at this tool, not at the server: the server's address is
 * told to the tool separately, and the tool forwards to it.
 */
function ompLocalModels(modelId: string, proxyBaseUrl: string): SetupFile {
  return {
    path: "~/.omp/agent/models.yml",
    language: "yaml",
    body: [
      "providers:",
      "  local:",
      "    baseUrl:",
      `      ${proxyBaseUrl}`,
      "    auth: none",
      "    api: openai-completions",
      "    models:",
      "      - id:",
      `        ${modelId}`,
      "        name: Local",
      "        api: openai-completions",
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
    id: "omp",
    label: "Oh My Pi",
    providers: [
      {
        id: "anthropic",
        label: "Anthropic",
        upstreamHost: "api.anthropic.com",
        renderer: "anthropic",
        env: [["ANTHROPIC_BASE_URL", "{baseUrl}"]],
        bin: "omp",
        notes: [
          "One variable, no config file. It works with an Anthropic API key " +
            "and with a Claude subscription login; your login stays active, " +
            "only the model traffic moves.",
          "The variable lasts for the run it is printed in. Nothing is " +
            "written to any file, so your normal Oh My Pi is unchanged the " +
            "moment you stop using this command.",
          "Oh My Pi also makes small background calls with a smaller model, " +
            "such as titling a session. When that model runs on this " +
            "provider, each turn writes a few extra small captures alongside " +
            "the real one. That is what the agent really sends.",
        ],
      },
      {
        id: "openai",
        label: "OpenAI API key",
        upstreamHost: "api.openai.com",
        renderer: "openai",
        // omp's OpenAI transport appends only /responses, so the base URL has
        // to carry the /v1.
        suffix: "/v1",
        bin: "omp",
        setup: [ompModels("openai", "{baseUrl}")],
        notes: [
          "Oh My Pi has no base URL variable on this route. Overriding the " +
            "provider in its models file is the only way to point it at this " +
            "tool, and it keeps the agent's whole built-in model list. If " +
            "that file already exists, add this provider to it rather than " +
            "replacing it, or your other providers disappear.",
        ],
      },
      {
        id: "codex",
        label: "ChatGPT subscription",
        upstreamHost: "chatgpt.com",
        renderer: "openai",
        // omp appends `/codex/responses` itself, and the real endpoint sits
        // under `/backend-api`, so the base URL must carry that prefix.
        suffix: "/backend-api",
        env: [["PI_CODEX_WEBSOCKET", "false"]],
        bin: "omp",
        setup: [ompModels("openai-codex", "{baseUrl}")],
        notes: [
          "The flag and the file do different jobs. The file moves the " +
            "endpoint; the flag stops Oh My Pi opening a WebSocket, which " +
            "this tool cannot see. With the flag it streams over HTTP, so " +
            "every turn is captured. It works with a ChatGPT subscription " +
            "login.",
          "If the models file already exists, add this provider to it rather " +
            "than replacing it.",
        ],
      },
      {
        id: "local",
        label: "Local model (Ollama, vLLM, LM Studio, …)",
        // Placeholder. The real host and port come from the student's URL at
        // resolve time; a local server lives on their machine.
        upstreamHost: "127.0.0.1",
        renderer: "openai",
        local: true,
        // omp's openai-completions transport appends only /chat/completions, so
        // the base URL has to carry the /v1.
        suffix: "/v1",
        bin: "omp",
        notes: [LOCAL_NOTE],
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
  /** True when picking this provider asks for the address of a local server. */
  local: boolean;
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
  return agent.providers.map((p) => ({
    id: p.id,
    label: p.label,
    local: !!p.local,
  }));
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

  // "Other" at either question means the same thing: the catalogue has no entry
  // for this student. Checked before the agent lookup, because "other" is not
  // an agent and must not read as an unknown one.
  if (choice.agent === OTHER_ID || choice.provider === OTHER_ID) {
    return {
      kind: "request",
      agentLabel: agent?.label ?? null,
      url: ISSUE_URL,
    };
  }

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

  // A local model server lives on the student's machine, so its host and port
  // are not in the catalogue. They come from the URL the student gave the
  // wizard. Without that URL there is nothing to forward to, so this is an
  // error, not a guess.
  if (provider.local) {
    if (!choice.localUrl) {
      return {
        kind: "error",
        message:
          `${agent.label} on a local model needs the address of your local ` +
          `model server. Run with --force and enter it when asked.`,
      };
    }
    let up: LocalUpstream;
    try {
      up = localUpstream(choice.localUrl);
    } catch (err) {
      return { kind: "error", message: (err as Error).message };
    }
    const modelId = choice.localModel ?? "local";
    return {
      kind: "target",
      agent: agent.id,
      agentLabel: agent.label,
      provider: provider.id,
      providerLabel: provider.label,
      upstreamHost: up.host,
      upstreamScheme: up.scheme,
      upstreamPort: up.port,
      upstreamPrefix: up.prefix,
      renderer: provider.renderer,
      baseUrl,
      // The model is addressed as local/<id>: `local` is the provider id in
      // the models file, and <id> is the model the server offers. The smol
      // role is pinned to the same model so background calls stay local too.
      command: `omp --model local/${modelId} --smol local/${modelId}`,
      setup: [ompLocalModels(modelId, baseUrl)],
      notes: provider.notes ?? [],
      warnings: provider.warnings ?? [],
    };
  }

  return {
    kind: "target",
    agent: agent.id,
    agentLabel: agent.label,
    provider: provider.id,
    providerLabel: provider.label,
    upstreamHost: provider.upstreamHost,
    upstreamScheme: "https",
    upstreamPort: 443,
    upstreamPrefix: "",
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
