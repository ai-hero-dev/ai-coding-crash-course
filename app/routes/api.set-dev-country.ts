import { redirect } from "react-router";
import { z } from "zod";
import type { Route } from "./+types/api.set-dev-country";
import { setDevCountry } from "~/lib/session";
import { parseFormData } from "~/lib/validation";

const setDevCountrySchema = z.object({
  country: z.string().length(2).or(z.literal("")).transform((v) => v || null),
});

export async function action({ request }: Route.ActionArgs) {
  const formData = await request.formData();
  const parsed = parseFormData(formData, setDevCountrySchema);

  const country = parsed.success ? parsed.data.country : null;

  const cookie = await setDevCountry(request, country);

  return redirect(new URL(request.url).searchParams.get("redirectTo") ?? "/", {
    headers: { "Set-Cookie": cookie },
  });
}
