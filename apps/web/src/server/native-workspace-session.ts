import { getCookies } from "better-auth/cookies";

import { auth } from "~/lib/auth";

/** Browser authority comes only from the supplied native credential, never an
 * ambient cookie from a different account. The signed token stays HttpOnly. */
export async function nativeWorkspaceSession(request: Request) {
  const authorization = request.headers.get("authorization");
  const bearer = /^Bearer (\S+)$/u.exec(authorization ?? "")?.[1];
  const headers = new Headers({ "Cache-Control": "private, no-store" });
  if (!bearer)
    return new Response("Native bearer credential required", {
      status: 401,
      headers,
    });
  const session = await auth.api.getSession({
    headers: new Headers({ Authorization: `Bearer ${bearer}` }),
    query: { disableCookieCache: true, disableRefresh: true },
  });
  if (!session?.user)
    return new Response("Native session is expired or invalid", {
      status: 401,
      headers,
    });
  const cookie = getCookies(auth.options).sessionToken;
  const attributes = cookie.attributes;
  // Preserve the configured name/security mode (including local HTTP tests).
  // Clamp cookie lifetime to the verified session's own expiry.
  const lifetime = Math.max(
    0,
    Math.floor(
      (new Date(session.session.expiresAt).getTime() - Date.now()) / 1000,
    ),
  );
  headers.append(
    "Set-Cookie",
    [
      `${cookie.name}=${encodeURIComponent(bearer)}`,
      `Path=${attributes.path}`,
      `Max-Age=${lifetime}`,
      "HttpOnly",
      `SameSite=${attributes.sameSite}`,
      ...(attributes.secure ? ["Secure"] : []),
      ...(attributes.domain ? [`Domain=${attributes.domain}`] : []),
    ].join("; "),
  );
  return new Response(null, { status: 204, headers });
}
