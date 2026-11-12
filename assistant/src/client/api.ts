/** The assistant's own API, under whatever prefix the page was built for. */
export const BASE = import.meta.env.BASE_URL.replace(/\/+$/, "");

export interface Intent {
  product: "app" | "report";
  kind: string;
  object: string;
  id?: string;
  title: string;
}

export interface Session {
  user: { email: string; name: string; admin: boolean };
  enabled: boolean;
  chatOnly: boolean;
  appName: string;
}

export type SessionState =
  | { status: "loading" }
  | { status: "signedOut" }
  | { status: "unreachable" }
  | { status: "signedIn"; session: Session };

export async function loadSession(): Promise<SessionState> {
  try {
    const response = await fetch(`${BASE}/api/session`, { credentials: "same-origin" });
    if (response.status === 401) return { status: "signedOut" };
    if (!response.ok) return { status: "unreachable" };
    return { status: "signedIn", session: (await response.json()) as Session };
  } catch {
    return { status: "unreachable" };
  }
}

export async function signIn(email: string, password: string): Promise<string | null> {
  const response = await fetch(`${BASE}/api/auth/sign-in/email`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (response.ok) return null;
  if (response.status === 429) return "Too many attempts. Wait a minute and try again.";
  return "That e-mail address and password do not match an account.";
}

export async function signOut(): Promise<void> {
  await fetch(`${BASE}/api/auth/sign-out`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: "{}",
  }).catch(() => undefined);
}

/** Exchange an intent for a single-use ticket. Null when it is not available to this person. */
export async function ticketFor(intent: Intent): Promise<string | null> {
  const response = await fetch(`${BASE}/api/tickets`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(intent),
  });
  if (!response.ok) return null;
  return ((await response.json()) as { ticket: string }).ticket;
}

export const intentKey = (intent: Intent): string =>
  `${intent.product}:${intent.kind}:${intent.object}:${intent.id ?? ""}`;
