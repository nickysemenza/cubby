import type { SessionSeed } from "~/lib/session-seed";
import { getAuth } from "~/server/http/auth";
import { requestScopedSession } from "~/server/http/http-session-cache";

const guardSession = requestScopedSession((options) =>
  getAuth().api.getSession(options),
);

/**
 * SSR authentication: the identity the route guard checks, and the session
 * payload the client's `/get-session` would return, minus the bearer token.
 */
export async function readGuardSession(
  headers: Headers,
): Promise<{ userId: string; seed: SessionSeed } | null> {
  const { response } = await guardSession({ headers, returnHeaders: true });
  if (!response?.user) return null;
  const { token: _token, ...session } = response.session;
  return {
    userId: response.user.id,
    seed: JSON.stringify({ session, user: response.user }),
  };
}
