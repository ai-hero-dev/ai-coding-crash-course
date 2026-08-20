/** OpenAI-compatible model discovery for the narrow OpenCode custom-target flow. */

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
