import { redirect } from "react-router";
import type { Route } from "./+types/api.logout";
import { destroySession } from "~/lib/session";

export async function action({ request }: Route.ActionArgs) {
  const cookie = await destroySession(request);

  return redirect("/", {
    headers: { "Set-Cookie": cookie },
  });
}
