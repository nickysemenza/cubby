import { getAuth } from "~/lib/auth";
import {
  authenticate,
  isChallenge,
  NATIVE_SESSION_EXCHANGE_AUTH,
} from "~/server/http/authenticate";

/** Browser authority comes only from the supplied native credential, never an
 * ambient cookie from a different account. The signed token stays HttpOnly. */
export async function nativeWorkspaceSession(request: Request) {
  const headers = new Headers({ "Cache-Control": "private, no-store" });
  const authenticated = await authenticate(
    request,
    NATIVE_SESSION_EXCHANGE_AUTH,
  );
  // The exchange accepts only a bearer, so a verified principal proves this
  // header carried the token the cookie below stores.
  const bearer = /^Bearer (\S+)$/u.exec(
    request.headers.get("authorization") ?? "",
  )?.[1];
  if (isChallenge(authenticated) || !bearer || !authenticated.session)
    return new Response("Native session is expired or invalid", {
      status: 401,
      headers,
    });
  const cookie = (await getAuth().$context).authCookies.sessionToken;
  const attributes = cookie.attributes;
  // Preserve the configured name/security mode (including local HTTP tests).
  // Clamp cookie lifetime to the verified session's own expiry.
  const expiresAt = authenticated.session.expiresAt?.getTime() ?? Date.now();
  const lifetime = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
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
