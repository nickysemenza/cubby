import { getAuth } from "~/server/http/auth";
import { requestScopedSession } from "~/server/http/http-session-cache";

const guardSession = requestScopedSession((options) =>
  getAuth().api.getSession(options),
);

/** SSR authentication projects only the identity used by the route guard. */
export async function readGuardSession(
  headers: Headers,
): Promise<{ userId: string } | null> {
  const { response } = await guardSession({ headers, returnHeaders: true });
  return response?.user ? { userId: response.user.id } : null;
}
