import { auth } from "~/lib/auth";

/** SSR authentication projects only the identity used by the route guard. */
export async function readGuardSession(
  headers: Headers,
): Promise<{ userId: string } | null> {
  const session = await auth.api.getSession({ headers });
  return session?.user ? { userId: session.user.id } : null;
}
