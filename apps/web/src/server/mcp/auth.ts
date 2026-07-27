import { type UserId, unsafeUserId } from "@cubby/schemas/identifiers";
import { verifyAccessToken } from "better-auth/oauth2";
import { MCP_RESOURCE, OAUTH_ISSUER } from "~/lib/auth";

/**
 * OAuth 2.1 bearer-token auth for the MCP endpoint.
 *
 * Access tokens are JWTs signed by our own authorization server (the
 * `oauthProvider` + `jwt` plugins in ~/lib/auth), so verification is local: pull
 * the JWKS once, check signature + `iss` + `aud` + `exp`. No DB round trip, and
 * nothing to leak into a URL — which is the whole point of moving off the
 * `?key=<apiKey>` scheme this replaced.
 */

const JWKS_URL = `${OAUTH_ISSUER}/jwks`;

/**
 * The URL an unauthenticated client should fetch to learn how to authenticate.
 * Shape is fixed by RFC 9728 (origin + `/.well-known/oauth-protected-resource`
 * + the resource's path), and matches what the better-auth plugin's own
 * `handleMcpErrors` would emit for this audience.
 */
const RESOURCE_METADATA_URL = (() => {
  const url = new URL(MCP_RESOURCE);
  return `${url.origin}/.well-known/oauth-protected-resource${url.pathname}`;
})();

export interface McpActor {
  userId: UserId;
  /** `sid` claim — the better-auth session the grant hangs off, if present. */
  sessionId: string | null;
}

/**
 * Verify the `Authorization: Bearer <jwt>` on an MCP request.
 *
 * Returns null for anything unauthenticated — missing header, malformed token,
 * bad signature, wrong issuer/audience, expired. Callers respond with
 * {@link unauthorizedResponse}.
 */
export async function verifyMcpToken(
  request: Request,
): Promise<McpActor | null> {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) return null;

  const token = authorization.slice("Bearer ".length).trim();
  if (!token) return null;

  try {
    const payload = await verifyAccessToken(token, {
      jwksUrl: JWKS_URL,
      verifyOptions: { issuer: OAUTH_ISSUER, audience: MCP_RESOURCE },
    });
    // `subjectType` is left at its "public" default, so `sub` is the user id
    // verbatim rather than a pairwise pseudonym.
    if (typeof payload.sub !== "string" || !payload.sub) return null;
    return {
      userId: unsafeUserId(payload.sub),
      sessionId: typeof payload.sid === "string" ? payload.sid : null,
    };
  } catch {
    return null;
  }
}

/**
 * 401 that tells an MCP client where to start the OAuth flow. Without the
 * `WWW-Authenticate` header a client just reports a failed connection instead
 * of offering to sign in.
 */
export function unauthorizedResponse() {
  return new Response(JSON.stringify({ error: "Unauthorized" }), {
    status: 401,
    headers: {
      "Content-Type": "application/json",
      "WWW-Authenticate": `Bearer resource_metadata="${RESOURCE_METADATA_URL}"`,
    },
  });
}
