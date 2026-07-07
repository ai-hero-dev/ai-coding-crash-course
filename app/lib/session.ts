import { createCookieSessionStorage } from "react-router";

const sessionStorage = createCookieSessionStorage({
  cookie: {
    name: "cadence_session",
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secrets: ["cadence-dev-secret"],
  },
});

export async function getSession(request: Request) {
  return sessionStorage.getSession(request.headers.get("Cookie"));
}

export async function getCurrentUserId(request: Request): Promise<number | null> {
  const session = await getSession(request);
  const userId = session.get("userId");
  return typeof userId === "number" ? userId : null;
}

export async function setCurrentUserId(request: Request, userId: number) {
  const session = await getSession(request);
  session.set("userId", userId);
  return sessionStorage.commitSession(session);
}

export async function destroySession(request: Request) {
  const session = await getSession(request);
  return sessionStorage.destroySession(session);
}

export async function getDevCountry(request: Request): Promise<string | null> {
  const session = await getSession(request);
  const country = session.get("devCountry");
  return typeof country === "string" ? country : null;
}

export async function setDevCountry(request: Request, country: string | null) {
  const session = await getSession(request);
  if (country) {
    session.set("devCountry", country);
  } else {
    session.unset("devCountry");
  }
  return sessionStorage.commitSession(session);
}
