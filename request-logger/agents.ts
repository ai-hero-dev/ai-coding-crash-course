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
 *
 * Not every student's setup fits a catalogue entry, though — a local model
 * server or a small provider has no fixed host to hard-code. For those, the
 * wizard offers "Custom base URL" wherever it offers a provider, and builds a
 * CustomTarget from what the student types instead of looking one up. See
 * resolveCustomTarget below.
 */

export type RendererId = "anthropic" | "openai" | "gemini" | "raw";

/**
 * What the student picked. This, and only this, is what gets saved to disk —
 * except the custom target fields, which are the one documented exception.
 * See config.ts.
 */
export interface AgentChoice {
  agent: string;
  provider?: string;
  /** Only set when provider is CUSTOM_ID: the base URL the student typed. */
  customBaseUrl?: string;
  /** Only set when provider is CUSTOM_ID: the wire format they chose for it. */
  customRenderer?: RendererId;
  /**
   * Selected model for a custom target that needs one declared up front:
   * OpenCode's custom OpenAI-compatible route, and any of Pi's custom
   * routes (see resolveCustomTarget).
   */
  customModel?: string;
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

/**
 * Resolved to a target the catalogue has no entry for: the student typed
 * their own base URL and picked their own wire format, rather than one being
 * looked up from a ProviderEntry. It plays the same role as a ResolvedTarget
 * everywhere downstream — the proxy routes to it and renders it exactly the
 * same way — so the two are only ever told apart by `kind`.
 */
export interface CustomTarget {
  kind: "custom-target";
  agent: string;
  agentLabel: string;
  /** Always "Custom base URL": there is no catalogue provider label to show. */
  providerLabel: string;
  /** The scheme+host[+port] the student typed, with any path stripped. */
  upstreamBaseUrl: string;
  renderer: RendererId;
  baseUrl: string;
  command: string;
  setup: SetupFile[];
  notes: string[];
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
  ResolvedTarget | CustomTarget | AgentRefusal | ResolveError | SetupRequest;

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

/**
 * The option next to "Other" at the provider question: a student whose
 * provider is not in the catalogue, but who knows its base URL, does not have
 * to file an issue and wait. This is offered on every supported agent's
 * provider question, however many catalogue providers it has — see
 * agentProviders and askChoice in config.ts.
 */
export const CUSTOM_ID = "custom";
export const CUSTOM_LABEL = "Custom base URL";

/**
 * The wire-format question a custom target answers instead of a renderer
 * being looked up from a ProviderEntry. "raw" is a real RendererId, not a
 * placeholder — render.ts checks it first and never guesses at a shape it
 * was not told.
 */
export const WIRE_FORMAT_OPTIONS: Array<{ id: RendererId; label: string }> = [
  { id: "openai", label: "OpenAI-compatible (chat/completions)" },
  { id: "anthropic", label: "Anthropic-compatible (messages)" },
  { id: "raw", label: "Not sure — show me the raw JSON" },
];

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
  /**
   * Which custom-base-url wire formats this provider's command, env and
   * setup file are a reasonable stand-in for. Only consulted on an agent
   * with more than one provider — see findCustomTemplate. A provider tied to
   * one specific login route (a ChatGPT subscription, a Google account) is
   * never tagged: reusing its template for an unrelated third-party server
   * would silently misconfigure it rather than help.
   */
  customTemplateFor?: RendererId[];
}

interface AgentEntry {
  id: string;
  label: string;
  /** A supported agent has providers. A refused one has a reason. */
  providers?: ProviderEntry[];
  reason?: string;
  /**
   * True when every setup for this agent is a custom target: there is no
   * fixed catalogue provider to fall back to, so the wizard skips the
   * provider question and asks the two custom-base-url questions directly.
   * OMP is the first agent like this — it can point at Ollama, LM Studio,
   * llama.cpp, LiteLLM, or anything else, so no single upstream host is ever
   * right for it.
   */
  alwaysCustom?: boolean;
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
 *
 * `modelId`, when given, is written as a one-entry `models` array under the
 * same provider. Pi replaces that provider's whole built-in model catalogue
 * with whatever `models` lists — see resolveCustomTarget's Pi branch, which
 * is the only caller that passes it. Omitted, as it is for every catalogue
 * entry above, Pi keeps its built-in catalogue for that provider, which is
 * correct there because those routes really do talk to Anthropic or OpenAI.
 */
function piModels(
  providerId: string,
  baseUrl: string,
  modelId?: string
): SetupFile {
  return {
    path: "~/.pi/agent/models.json",
    language: "json",
    body: [
      "{",
      '  "providers": {',
      `    "${providerId}": {`,
      `      "baseUrl": "${baseUrl}"${modelId ? "," : ""}`,
      ...(modelId ? [`      "models": [{ "id": "${modelId}" }]`] : []),
      "    }",
      "  }",
      "}",
    ].join("\n"),
  };
}

/**
 * OMP's provider override file, in YAML, under ~/.omp/agent/models.yml.
 *
 * OMP does not know, and this tool cannot know, which backend the student is
 * actually pointing at — Ollama, LM Studio, llama.cpp, LiteLLM, or something
 * else entirely — so the provider key below is a generic placeholder
 * ("custom") rather than a real backend name. OMP does not care what the key
 * is called, only that baseUrl is set correctly under it, so the placeholder
 * costs the student nothing; they may rename it if they prefer a name that
 * matches their backend.
 */
function ompModels(baseUrl: string): SetupFile {
  return {
    path: "~/.omp/agent/models.yml",
    language: "yaml",
    body: ["providers:", "  custom:", `    baseUrl: "${baseUrl}"`].join("\n"),
  };
}

const OMP_NOTE =
  "OMP has no backend of its own to hard-code the way the rest of this " +
  "catalogue does. It can point at Ollama, LM Studio, llama.cpp, LiteLLM, or " +
  "any other server that speaks one of the wire formats offered here, so " +
  "every OMP setup goes through the base URL and wire format you chose.";

/**
 * Junie's custom-model override, in JSON, under
 * ~/.junie/models/request-logger.json (see Junie's own Custom LLM models
 * docs). Junie also documents a *custom-proxy* mechanism — a "proxies" entry
 * in ~/.junie/config.json with a `kind` of "Anthropic" or "OpenAI" — and an
 * earlier version of this catalogue entry used that instead. It does not
 * work: driven against a real Junie CLI install (build 1543.24), that
 * config.json entry is never consulted, headless or interactive, regardless
 * of `kind` — Junie silently keeps using its normal authenticated backend
 * (JetBrains AI, or whatever BYOK key it already had) and nothing reaches
 * this tool. The custom-model route below is a different mechanism that was
 * verified to actually work the same way: a JSON profile Junie discovers
 * from `~/.junie/models/*.json` and that must be selected explicitly with
 * `--model custom:request-logger` (see the Junie ProviderEntry below).
 *
 * Unlike the proxy route's `api-url`, a model profile's `baseUrl` is the
 * *full* endpoint path, not an origin — Junie posts to it verbatim with no
 * path appended. Getting the suffix right (`/v1/messages` for Anthropic,
 * `/v1/chat/completions` for OpenAI — see each ProviderEntry.suffix below)
 * is what stands between a working capture and a silent 404. Confirmed by
 * driving both wire formats against a live proxy.
 *
 * `authHeaderValue` is a placeholder line, not a real credential — see
 * JUNIE_NOTE.
 */
function junieModelConfig(
  baseUrl: string,
  apiType: "Anthropic" | "OpenAICompletion",
  authHeaderName: string,
  authHeaderValue: string
): SetupFile {
  return {
    path: "~/.junie/models/request-logger.json",
    language: "json",
    body: [
      "{",
      `  "baseUrl": "${baseUrl}",`,
      '  "id": "request-logger",',
      `  "apiType": "${apiType}",`,
      '  "extraHeaders": {',
      `    "${authHeaderName}": "${authHeaderValue}"` +
        (apiType === "Anthropic" ? "," : ""),
      ...(apiType === "Anthropic"
        ? ['    "anthropic-version": "2023-06-01"']
        : []),
      "  }",
      "}",
    ].join("\n"),
  };
}

const JUNIE_NOTE =
  "Junie has no existing login for this tool to pass through the way Claude " +
  "Code or Codex do. This model profile bypasses JetBrains AI authentication " +
  "entirely, so a real API key for whichever backend you are logging goes " +
  "straight into the file in plaintext. Do not commit it.";

const JUNIE_PROXY_DOES_NOT_WORK_NOTE =
  "Junie's docs also describe a \"proxies\" entry in ~/.junie/config.json " +
  "for this. Do not use it instead of the file below: verified against a " +
  "real Junie CLI install (build 1543.24), that config is never consulted " +
  "— Junie keeps using its normal authenticated backend no matter what " +
  "`kind` is set to, with no error and an empty logs folder. The model " +
  "profile below is the mechanism that was actually driven end to end.";

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
        // Claude Code's own wire format is Anthropic-shaped regardless of
        // what a custom target claims to speak, so this stays the catch-all
        // for every wire format a custom target might pick — the same
        // "used regardless of the wire format chosen" guarantee this agent
        // had when it was the only provider, back when findCustomTemplate's
        // single-provider branch picked it unconditionally. Now that
        // "vertex" (below) is a second provider, that branch no longer
        // fires, so the guarantee has to be spelled out here instead.
        customTemplateFor: ["anthropic", "openai", "raw"],
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
      {
        id: "vertex",
        label: "Google Vertex AI",
        // Fixed to the global endpoint on purpose — see the region note below.
        upstreamHost: "aiplatform.googleapis.com",
        // Vertex's Claude endpoint is Anthropic's own Messages API shape,
        // routed by URL path instead of a body field — the model ID moves
        // from the body's "model" key into the URL
        // (.../publishers/anthropic/models/{model}:streamRawPredict), and
        // the body gains "anthropic_version". findModel() in render.ts
        // already falls back to reading the model out of the path when the
        // body has none, and the Anthropic renderer only reads specific
        // known keys, so the existing "anthropic" renderer reads this
        // correctly without a dedicated renderer of its own.
        renderer: "anthropic",
        env: [
          ["ANTHROPIC_VERTEX_BASE_URL", "{baseUrl}"],
          ["ENABLE_TOOL_SEARCH", "true"],
        ],
        bin: "claude",
        notes: [
          "This assumes CLAUDE_CODE_USE_VERTEX=1, CLOUD_ML_REGION and " +
            "ANTHROPIC_VERTEX_PROJECT_ID are already exported in your shell — " +
            "request-logger does not set those, only ANTHROPIC_VERTEX_BASE_URL, " +
            "which is the variable Claude Code actually reads for a base-URL " +
            "override once Vertex mode is on. ANTHROPIC_BASE_URL, used by the " +
            "plain Anthropic route above, is silently ignored in Vertex mode — " +
            "that mismatch is the usual reason a Vertex student's logs folder " +
            "stays empty.",
          "Only CLOUD_ML_REGION=global is supported by this entry. A regional " +
            "value (us-east5, say) talks to a different host " +
            "({region}-aiplatform.googleapis.com), which this entry does not " +
            "resolve to yet — ask for it via the issue tracker if you hit this.",
          "ENABLE_TOOL_SEARCH=true matters here for the same reason it does on " +
            "the plain Anthropic route above: a non-default host turns off tool " +
            "search unless this is set.",
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
        // The only usable template for a custom Codex target: Codex only
        // ever speaks the OpenAI-compatible wire format, so it is the
        // catch-all for every choice, including "anthropic" — a mismatch
        // there is Codex's limitation, not a bug in this tool.
        customTemplateFor: ["openai", "raw", "anthropic"],
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
        customTemplateFor: ["anthropic"],
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
        // Also the catch-all for "raw"/not sure: a third-party server behind
        // a custom base URL is far more often OpenAI-compatible than
        // Anthropic-compatible, so this is the better default guess.
        customTemplateFor: ["openai", "raw"],
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
        customTemplateFor: ["anthropic"],
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
        // Also the catch-all for "raw"/not sure — see the OpenCode entry
        // above for why an OpenAI-compatible guess is the better default.
        customTemplateFor: ["openai", "raw"],
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
            body: ["{", '  "transport": "sse"', "}"].join("\n"),
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
    label: "OMP (Oh My Pi)",
    // Every setup for OMP goes through the custom-base-url questions — see
    // AgentEntry.alwaysCustom. The one provider below never reaches the
    // wizard; it exists purely to hold the bin and setup-file template that
    // resolveCustomTarget borrows from, the same way findCustomTemplate
    // borrows from a real provider for every other agent.
    alwaysCustom: true,
    providers: [
      {
        id: CUSTOM_ID,
        label: CUSTOM_LABEL,
        // Unused: OMP never reaches the normal (non-custom) resolution path
        // that would read this.
        upstreamHost: "",
        // Irrelevant here too — the resolved renderer always comes from the
        // student's answer, not from this template. See resolveCustomTarget.
        renderer: "raw",
        bin: "omp",
        setup: [ompModels("{baseUrl}")],
        notes: [OMP_NOTE],
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
        // The only usable template for a custom Gemini CLI target: the
        // Google-login route is tied to that login and would misconfigure an
        // unrelated server. Gemini CLI's own wire format does not actually
        // match any of the custom choices, so this is a best-effort catch-all
        // for all three — a mismatch shows up as a renderer warning, not a
        // silent one.
        customTemplateFor: ["openai", "anthropic", "raw"],
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
    id: "junie",
    label: "Junie",
    // Junie is BYOK across several backends (OpenAI, Anthropic, Google, xAI,
    // OpenRouter, Copilot, a LiteLLM proxy) with no single fixed host of its
    // own — the same shape as OMP — so every setup for it is custom too. See
    // AgentEntry.alwaysCustom.
    //
    // Junie CLI is closed source, so most of this catalogue's other entries
    // cannot be checked against real source the way, say, Claude Code's can.
    // This entry is the one exception that was actually driven against a
    // real Junie CLI install (build 1543.24) rather than only against
    // JetBrains' published docs — see junieModelConfig's comment above for
    // what that testing found. Overall testing status is still recorded in
    // the README's "How much this was tested" section, the same way every
    // other agent's is; it is not printed to the student, the same way no
    // other agent's is either.
    alwaysCustom: true,
    providers: [
      {
        id: "anthropic",
        label: "Anthropic-compatible",
        // Unused: Junie never reaches the normal (non-custom) resolution
        // path that would read this. See resolveCustomTarget.
        upstreamHost: "",
        renderer: "raw",
        // A model profile's baseUrl is the full endpoint path, not an
        // origin — see junieModelConfig's comment.
        suffix: "/v1/messages",
        bin: "junie",
        // Junie only looks at a custom model when it is asked for by name.
        args: ["--model", "custom:request-logger"],
        customTemplateFor: ["anthropic"],
        setup: [
          junieModelConfig(
            "{baseUrl}",
            "Anthropic",
            "x-api-key",
            "YOUR_ANTHROPIC_API_KEY"
          ),
        ],
        notes: [JUNIE_NOTE, JUNIE_PROXY_DOES_NOT_WORK_NOTE],
      },
      {
        id: "openai",
        label: "OpenAI-compatible",
        // Unused, same as the Anthropic-compatible entry above: Junie never
        // reaches the normal (non-custom) resolution path that would read
        // this. See resolveCustomTarget.
        upstreamHost: "",
        renderer: "raw",
        suffix: "/v1/chat/completions",
        bin: "junie",
        args: ["--model", "custom:request-logger"],
        // Also the catch-all for "raw"/not sure — see the OpenCode and Pi
        // entries above for why an OpenAI-compatible guess is the better
        // default for an unidentified custom server.
        customTemplateFor: ["openai", "raw"],
        setup: [
          junieModelConfig(
            "{baseUrl}",
            "OpenAICompletion",
            "Authorization",
            "Bearer YOUR_OPENAI_API_KEY"
          ),
        ],
        notes: [JUNIE_NOTE, JUNIE_PROXY_DOES_NOT_WORK_NOTE],
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
  /** True when this agent has no catalogue provider: every setup is custom. */
  alwaysCustom: boolean;
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
    // An alwaysCustom agent never shows the provider question — askChoice
    // skips straight past it (see agent.alwaysCustom above) — regardless of
    // how many internal templates its catalogue entry holds for
    // findCustomTemplate to pick between. Junie is the first alwaysCustom
    // agent with more than one, so this used to be true by coincidence for
    // every alwaysCustom agent (OMP has exactly one provider); it is
    // spelled out here now that a second one exists.
    needsProvider: !agent.alwaysCustom && (agent.providers?.length ?? 0) > 1,
    alwaysCustom: agent.alwaysCustom === true,
  }));
  return [
    ...summaries.filter((agent) => agent.supported),
    ...summaries.filter((agent) => !agent.supported),
  ];
}

/**
 * The providers to ask about for one agent, when there is more than one to
 * choose between. Empty when there is nothing to ask — a refused agent has
 * none, and an agent with exactly one provider is assumed rather than asked.
 *
 * This stays gated at two on purpose, unchanged by the custom-base-url
 * mechanism: it describes the catalogue, not the wizard's options. See
 * agentProviders for the list config.ts actually builds the provider
 * question's options from, which is not gated this way.
 */
export function listProviders(agentId: string): ProviderSummary[] {
  const agent = AGENTS.find((a) => a.id === agentId);
  if (!agent?.providers || agent.providers.length < 2) return [];
  return agent.providers.map((p) => ({ id: p.id, label: p.label }));
}

/**
 * Every catalogue provider for one agent, regardless of how many there are.
 *
 * config.ts uses this, not listProviders, to build the provider question's
 * options — because "Custom base URL" is now offered at that question for
 * every supported agent, even one with a single catalogue provider, there is
 * always something to pick between even when listProviders would say there
 * is nothing to ask about.
 */
export function agentProviders(agentId: string): ProviderSummary[] {
  const agent = AGENTS.find((a) => a.id === agentId);
  return (agent?.providers ?? []).map((p) => ({ id: p.id, label: p.label }));
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
 *  - The direct Anthropic API counts tokens with a `count_tokens` path.
 *    Claude Code on Vertex AI reaches the same Anthropic wire format through a
 *    Vertex-style URL instead, whose token-counting call ends
 *    `:countTokens` — Vertex's own camelCase, colon-suffixed convention,
 *    not Anthropic's underscored one — so both spellings are matched below.
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
  // Matches both `count_tokens` (direct Anthropic API) and `countTokens`
  // (Claude Code on Vertex AI).
  return !/count[_-]?tokens/i.test(reqPath);
}

// ---------------------------------------------------------------------------
// Resolution — the seam
// ---------------------------------------------------------------------------

function buildCommand(
  provider: ProviderEntry,
  baseUrl: string,
  platform: NodeJS.Platform
): string {
  const fill = (text: string) => text.replace(/\{baseUrl\}/g, baseUrl);
  const env = (provider.env ?? []).map(
    ([key, value]) => [key, fill(value)] as const
  );
  // Arguments take the base URL too. Codex has no variable for it, so its
  // whole override arrives as a flag.
  const args = (provider.args ?? []).map(fill);
  const bin = [provider.bin, ...args].join(" ");
  return withEnv(env, bin, platform);
}

/**
 * Join one or more `KEY=value` environment assignments onto the command that
 * needs them, in whichever syntax the student's shell actually understands.
 *
 * POSIX shells — bash, zsh, and Windows' own WSL and Git Bash — accept
 * `KEY=value KEY2=value2 bin` directly, so that is the default this tool has
 * always printed. Windows' native PowerShell has no such syntax at all: typed
 * back verbatim, it comes back as "is not recognized as a name of a cmdlet"
 * (the report that prompted this function). PowerShell instead sets each
 * variable with its own `$env:KEY = 'value'` statement, chained onto one
 * line with semicolons the way PowerShell joins statements.
 */
function withEnv(
  env: ReadonlyArray<readonly [string, string]>,
  bin: string,
  platform: NodeJS.Platform
): string {
  if (env.length === 0) return bin;
  if (platform === "win32") {
    return [
      ...env.map(([key, value]) => `$env:${key} = ${powerShellQuote(value)}`),
      bin,
    ].join("; ");
  }
  return [...env.map(([key, value]) => `${key}=${value}`), bin].join(" ");
}

/** Quote one complete POSIX shell argument, including embedded single quotes. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

/**
 * Quote one complete PowerShell string literal, including embedded single
 * quotes (PowerShell escapes those by doubling them, not by backslash).
 * Single-quoted PowerShell strings do no interpolation at all — unlike
 * double-quoted ones, where a `$` in a base URL or a JSON config would be
 * read as the start of a variable — so this is the literal, injection-safe
 * quoting PowerShell offers.
 */
function powerShellQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Turn what the student typed into an origin (scheme + host [+ port]), or
 * nothing. Only http and https make sense here — the proxy speaks plain HTTP
 * to whatever it forwards to, over either transport — so anything else (a
 * bare host with no scheme, a typo, an unrelated protocol) is rejected
 * rather than guessed at. A wrong guess would fail as a confusing connection
 * error; this fails as a message the student can act on.
 */
function parseUpstreamUrl(raw: string): URL | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  return url;
}

/**
 * Which catalogue provider a custom target borrows its command, environment
 * variable and setup file from. A custom target has no ProviderEntry of its
 * own, but every agent still needs a real bin to print, and most need a real
 * env var or config file shape too — this is where those come from instead.
 *
 * An agent with exactly one provider has only one thing to borrow, so that
 * one is used regardless of the wire format chosen: it is a best-effort
 * template, not a promise, and a mismatch is worth a note, not a dead end.
 * An agent with more than one provider picks by matching the chosen wire
 * format against each provider's `customTemplateFor` tags — and only that:
 * an untagged provider is untagged on purpose (see the field's own doc,
 * above), so a format with no exact match returns `undefined` rather than
 * borrowing an unrelated provider's command. `resolveCustomTarget` already
 * degrades honestly when this returns nothing — a bare command, no setup
 * file, no borrowed notes — which is the correct outcome here, not a bug to
 * paper over.
 */
function findCustomTemplate(
  agent: AgentEntry,
  renderer: RendererId
): ProviderEntry | undefined {
  const providers = agent.providers ?? [];
  if (providers.length <= 1) return providers[0];
  return providers.find((p) => p.customTemplateFor?.includes(renderer));
}

/**
 * The note shown whenever a custom target's wire format is "raw" — the
 * student said they were not sure, so every capture falls back to a JSON
 * dump. Every custom-target route says this the same way, so it is written
 * once here rather than copied into each one.
 */
const RAW_WIRE_FORMAT_NOTE =
  'You picked "not sure" for the wire format, so every capture falls ' +
  "back to a raw JSON dump instead of a fully rendered one. That is " +
  "not broken — it is just less readable. Run with --force and pick a " +
  "format once you know it, and the readable renderer takes over.";

/**
 * Whether a custom target for this agent and wire format needs a model
 * declared up front, rather than being able to start against a bare base
 * URL. The single source of truth both the wizard (config.ts, deciding
 * whether to bother discovering one) and resolveCustomTarget (deciding
 * whether to require one) consult, so a third agent that needs this only
 * ever means one edit, here.
 *
 * - OpenCode only needs one for its OpenAI-compatible route: that is the
 *   one built from an ephemeral provider with no catalogue entry to borrow
 *   a model from. Its Anthropic-compatible route borrows a real Anthropic
 *   provider instead, whose model names are real Anthropic model names.
 * - Pi needs one on every route: every one of its custom targets overrides
 *   an existing built-in provider (openai or anthropic), and that
 *   provider's built-in model names almost never exist on a self-hosted
 *   backend, whichever wire format was chosen for rendering.
 */
export function customTargetNeedsModel(
  agentId: string,
  renderer: RendererId
): boolean {
  if (agentId === "pi") return true;
  if (agentId === "opencode") return renderer === "openai";
  return false;
}

/**
 * Read the model the wizard asked for, or the error both routes that need
 * one return when it is missing — a remembered choice saved before this
 * field existed, say, or one edited by hand. Shared so the two routes that
 * call customTargetNeedsModel report the same shape of error, differing
 * only in which target they name.
 */
function resolveCustomModel(
  choice: AgentChoice,
  targetLabel: string
): { kind: "model"; model: string } | ResolveError {
  const model = choice.customModel?.trim();
  if (!model) {
    return {
      kind: "error",
      message: `${targetLabel} needs a model ID. Run with --force to choose again.`,
    };
  }
  return { kind: "model", model };
}

/**
 * Build a target from what the student typed, in place of a catalogue
 * lookup. The only facts on hand are the base URL and the wire format they
 * chose; everything else is borrowed from the closest matching catalogue
 * provider — see findCustomTemplate.
 */
function resolveCustomTarget(
  agent: AgentEntry,
  choice: AgentChoice,
  port: number,
  platform: NodeJS.Platform
): Resolution {
  if (!choice.customBaseUrl) {
    return {
      kind: "error",
      message: `${agent.label} needs a custom base URL. Run with --force to choose again.`,
    };
  }

  const upstream = parseUpstreamUrl(choice.customBaseUrl);
  if (!upstream) {
    return {
      kind: "error",
      message:
        `"${choice.customBaseUrl}" is not a usable base URL. It must start ` +
        `with http:// or https://, e.g. http://localhost:11434. Run with ` +
        `--force to choose again.`,
    };
  }

  const renderer: RendererId = choice.customRenderer ?? "raw";
  const template = findCustomTemplate(agent, renderer);
  const baseUrl = `http://localhost:${port}${template?.suffix ?? ""}`;

  if (agent.id === "opencode" && customTargetNeedsModel(agent.id, renderer)) {
    const modelResult = resolveCustomModel(
      choice,
      "OpenCode's custom OpenAI-compatible target"
    );
    if (modelResult.kind === "error") return modelResult;
    const { model } = modelResult;

    const providerId = "request-logger";
    const selectedModel = `${providerId}/${model}`;
    const config = JSON.stringify({
      model: selectedModel,
      small_model: selectedModel,
      provider: {
        [providerId]: {
          npm: "@ai-sdk/openai-compatible",
          name: "Request Logger",
          options: { baseURL: baseUrl },
          models: { [model]: { name: model } },
        },
      },
    });

    return {
      kind: "custom-target",
      agent: agent.id,
      agentLabel: agent.label,
      providerLabel: CUSTOM_LABEL,
      upstreamBaseUrl: upstream.origin,
      renderer,
      baseUrl,
      command:
        platform === "win32"
          ? `$env:OPENCODE_CONFIG_CONTENT = ${powerShellQuote(config)}; opencode`
          : `OPENCODE_CONFIG_CONTENT=${shellQuote(config)} opencode`,
      setup: [],
      notes: [
        "This temporary provider is merged with your existing OpenCode " +
          "configuration for this run only; your config file is not changed.",
      ],
      warnings: [],
    };
  }

  /**
   * Pi's custom target, on every wire format — unlike OpenCode's branch
   * above, which only fires for the OpenAI-compatible choice. Pi always
   * writes a models.json override for a custom base URL (see piModels), and
   * that override always replaces one of Pi's built-in providers, whose
   * built-in model names (gpt-4o, claude-*) almost never exist on a
   * self-hosted backend regardless of which wire format the student picked
   * for rendering. So a model is required here every time, not just for one
   * renderer.
   */
  if (agent.id === "pi" && customTargetNeedsModel(agent.id, renderer)) {
    const modelResult = resolveCustomModel(choice, "Pi's custom target");
    if (modelResult.kind === "error") return modelResult;
    const { model } = modelResult;

    // template is the anthropic or openai Pi provider entry (see
    // findCustomTemplate). Every renderer this branch can be reached with
    // ("openai", "anthropic", "raw") has a Pi provider tagged for it — see
    // the catalogue above — so this can only be missing if a future wire
    // format is added there without a matching Pi template.
    if (!template) {
      return {
        kind: "error",
        message:
          `Pi has no custom-target template for the "${renderer}" wire ` +
          `format. Run with --force to choose again.`,
      };
    }
    // template.id is the provider key Pi's built-in catalogue uses, which
    // is also the key this override replaces.
    const providerId = template.id;
    const notes = [
      `This models.json entry replaces Pi's built-in "${providerId}" model ` +
        "catalogue with the one model you selected, since Pi's built-in " +
        "model names almost never exist on a custom server.",
    ];
    if (renderer === "anthropic") {
      notes.push(
        "Model discovery only checks the OpenAI-style /v1/models listing " +
          "endpoint, which an Anthropic-compatible server often does not " +
          "expose. If discovery found nothing here and you typed the model " +
          "ID by hand, that is expected — it does not mean the ID is wrong."
      );
    }
    if (renderer === "raw") notes.push(RAW_WIRE_FORMAT_NOTE);

    return {
      kind: "custom-target",
      agent: agent.id,
      agentLabel: agent.label,
      providerLabel: CUSTOM_LABEL,
      upstreamBaseUrl: upstream.origin,
      renderer,
      baseUrl,
      command: buildCommand(template, baseUrl, platform),
      setup: [piModels(providerId, baseUrl, model)],
      notes,
      warnings: template.warnings ?? [],
    };
  }

  const notes = [
    `This command is built from ${agent.label}'s own setup pattern, since a ` +
      `custom target has no dedicated one of its own. If a note below assumes ` +
      `a specific login or account, it may not apply to your target.`,
    ...(template?.notes ?? []),
  ];
  if (renderer === "raw") notes.push(RAW_WIRE_FORMAT_NOTE);

  return {
    kind: "custom-target",
    agent: agent.id,
    agentLabel: agent.label,
    providerLabel: CUSTOM_LABEL,
    upstreamBaseUrl: upstream.origin,
    renderer,
    baseUrl,
    command: template ? buildCommand(template, baseUrl, platform) : agent.id,
    setup: (template?.setup ?? []).map((file) => ({
      ...file,
      body: file.body.replace(/\{baseUrl\}/g, baseUrl),
    })),
    notes,
    warnings: template?.warnings ?? [],
  };
}

/**
 * Turn a saved choice into everything the tool needs, or into a clear reason
 * why it cannot.
 *
 * Pure: no disk, no network, no clock. Give it the same choice, the same
 * port and the same platform and it gives back the same answer. `platform`
 * decides only the shell syntax of the printed command — POSIX `KEY=value
 * bin` everywhere except win32, where PowerShell needs `$env:KEY = 'value'`
 * statements instead (see withEnv). The caller reads `process.platform`
 * once and passes it in, the same way it already does for `port`.
 */
export function resolveChoice(
  choice: AgentChoice,
  options: { port: number; platform: NodeJS.Platform }
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

  // A custom target is resolved from what the student typed, not from a
  // catalogue lookup — either because they chose "Custom base URL" at the
  // provider question, or because every setup for this agent is custom
  // (alwaysCustom, e.g. OMP), which never shows that question at all.
  if (agent.alwaysCustom || choice.provider === CUSTOM_ID) {
    return resolveCustomTarget(agent, choice, options.port, options.platform);
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
    command: buildCommand(provider, baseUrl, options.platform),
    setup: (provider.setup ?? []).map((file) => ({
      ...file,
      body: file.body.replace(/\{baseUrl\}/g, baseUrl),
    })),
    notes: provider.notes ?? [],
    warnings: provider.warnings ?? [],
  };
}
