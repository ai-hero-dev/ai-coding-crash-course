import { getSession } from "~/lib/session";

// ─── Country Resolution ───
// Layered approach: (1) dev session override, (2) CF-IPCountry header, (3) ip-api.com fallback.
// Returns a 2-letter ISO country code or null.

export async function resolveCountry(request: Request): Promise<string | null> {
  // 1. Dev session override
  const session = await getSession(request);
  const devCountry = session.get("devCountry");
  if (typeof devCountry === "string" && devCountry.length === 2) {
    return devCountry.toUpperCase();
  }

  // 2. Cloudflare CF-IPCountry header
  const cfCountry = request.headers.get("CF-IPCountry");
  if (cfCountry && cfCountry.length === 2 && cfCountry !== "XX") {
    return cfCountry.toUpperCase();
  }

  // 3. ip-api.com fallback
  try {
    const ip = request.headers.get("X-Forwarded-For")?.split(",")[0]?.trim();
    if (ip) {
      const response = await fetch(`http://ip-api.com/json/${ip}?fields=countryCode`);
      if (response.ok) {
        const data = await response.json();
        if (data.countryCode && typeof data.countryCode === "string") {
          return data.countryCode.toUpperCase();
        }
      }
    }
  } catch {
    // Silently fail — default to null (treated as Tier 1)
  }

  return null;
}
