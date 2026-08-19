/**
 * local.ts — asks a local model server what models it offers.
 *
 * The rest of the tool is pure: agents.ts never touches the network, and the
 * proxy only forwards. The probe is the one place that talks to the student's
 * machine, because it happens once, in the wizard, when the student types the
 * address of their server. Its job is narrow: find the model ids the server
 * offers, so the wizard can let the student pick one and the rest of the tool
 * can work with that id.
 *
 * Every server we target serves the OpenAI-compatible API, so the primary probe
 * is the OpenAI models endpoint. Ollama also answers the native /api/tags, which
 * is probed as a fallback for servers that do not expose the OpenAI route.
 */

/** The answer to "what models does this server offer?". */
export interface LocalProbe {
  /** True when at least one model was found. */
  ok: boolean;
  /** The model ids the server offers, in the order it reported them. */
  models: string[];
  /** Why the probe failed, when it did. */
  error?: string;
}

/** How long the wizard waits for a server to answer before giving up. */
const PROBE_TIMEOUT_MS = 5000;

/**
 * Ask a local model server for the models it offers.
 *
 * Pure enough to test: the only input is a URL and the only output is a list of
 * model ids (or an error). No global state, no clock beyond the fetch timeout.
 */
export async function probeLocalServer(url: string): Promise<LocalProbe> {
  let root: string;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { ok: false, models: [], error: `a local model server must speak http or https` };
    }
    // The base the server serves its API under, with no trailing slash. A
    // trailing /v1 is dropped, because the candidates below add it themselves.
    root = `${parsed.protocol}//${parsed.host}${parsed.pathname.replace(/\/+$/, "")}`.replace(
      /\/v1$/,
      ""
    );
  } catch {
    return { ok: false, models: [], error: `"${url}" is not a URL` };
  }

  // The OpenAI models endpoint lives under /v1 on most servers and under / on
  // some. Try both, then Ollama's native tag list.
  const candidates = [`${root}/v1/models`, `${root}/models`, `${root}/api/tags`];
  for (const candidate of candidates) {
    const found = await fetchModels(candidate);
    if (found.length > 0) return { ok: true, models: found };
  }

  return {
    ok: false,
    models: [],
    error: `no models found at ${url}. Is the server running, and does it serve the OpenAI-compatible API?`,
  };
}

/** Fetch one models endpoint and return the model ids it lists, or none. */
async function fetchModels(endpoint: string): Promise<string[]> {
  let res: Response;
  try {
    res = await fetch(endpoint, {
      method: "GET",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
  } catch {
    return [];
  }
  if (!res.ok) return [];

  let json: unknown;
  try {
    json = await res.json();
  } catch {
    return [];
  }

  if (json == null || typeof json !== "object") return [];
  const body = json as { data?: unknown; models?: unknown };

  // OpenAI shape: { "data": [ { "id": "..." } ] }
  if (Array.isArray(body.data)) return modelIds(body.data, "id");
  // Ollama shape: { "models": [ { "name": "..." } ] }
  if (Array.isArray(body.models)) return modelIds(body.models, "name");
  return [];
}

/**
 * Pull a single string field out of a list of model objects. The field is
 * `id` on the OpenAI wire and `name` on Ollama's native wire; everything else
 * is skipped, so a server that answers with an unexpected shape is a no-op,
 * not a crash.
 */
function modelIds(list: unknown[], field: "id" | "name"): string[] {
  const ids: string[] = [];
  for (const item of list) {
    if (item == null || typeof item !== "object") continue;
    const candidate = (item as Record<string, unknown>)[field];
    if (typeof candidate === "string" && candidate.length > 0) ids.push(candidate);
  }
  return ids;
}
