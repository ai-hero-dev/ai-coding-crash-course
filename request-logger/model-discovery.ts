/**
 * OpenAI-compatible model discovery for a custom base URL — the unauthenticated
 * `/v1/models` listing endpoint most local and third-party model servers
 * expose. Agent-agnostic on purpose: OpenCode's custom OpenAI-compatible
 * route and Pi's custom routes both need a real model ID up front, and both
 * discover it the same way.
 */

export const MODEL_DISCOVERY_TIMEOUT_MS = 3_000;

export function parseModelIds(body: unknown): string[] {
  if (
    typeof body !== "object" ||
    body === null ||
    !("data" in body) ||
    !Array.isArray(body.data)
  ) {
    return [];
  }

  const ids = body.data.flatMap((entry): string[] => {
    if (
      typeof entry !== "object" ||
      entry === null ||
      !("id" in entry) ||
      typeof entry.id !== "string" ||
      entry.id.trim().length === 0
    ) {
      return [];
    }
    return [entry.id];
  });

  return [...new Set(ids)];
}

interface DiscoverOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export async function discoverModelIds(
  baseUrl: string,
  options: DiscoverOptions = {}
): Promise<string[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? MODEL_DISCOVERY_TIMEOUT_MS;

  try {
    const origin = new URL(baseUrl).origin;
    const response = await fetchImpl(`${origin}/v1/models`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return [];
    return parseModelIds(await response.json());
  } catch {
    return [];
  }
}
