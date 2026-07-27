import { type UserId, unsafeUserId } from "@cubby/schemas/identifiers";
import { verifyJwsAccessToken } from "better-auth/oauth2";
import { auth, MCP_RESOURCE, OAUTH_ISSUER } from "~/lib/auth";

/**
 * OAuth 2.1 bearer-token auth for the MCP endpoint.
 *
 * Access tokens are JWTs signed by our own authorization server (the
 * `oauthProvider` + `jwt` plugins in ~/lib/auth), so verification is local: pull
 * the JWKS once, check signature + `iss` + `aud` + `exp`. No DB round trip, and
 * nothing to leak into a URL — which is the whole point of moving off the
 * `?key=<apiKey>` scheme this replaced.
 */

/**
 * Read our own JWKS in-process instead of over the network.
 *
 * The obvious form — `jwksUrl: "<origin>/api/auth/jwks"` — fails in production
 * with `Jwks failed: <none>`: it makes the Worker issue a subrequest to its own
 * custom hostname, which Cloudflare does not route back to the same Worker.
 * Locally it works fine (a plain localhost fetch), so this only ever breaks
 * once deployed. Reading the key set directly is also simply better: no HTTP
 * round trip on the MCP hot path.
 */
const fetchJwks = () => auth.api.getJwks();

/**
 * Stable identity for better-auth's JWKS cache. Without it, a function-based
 * key source is re-read on every single verification.
 */
const JWKS_CACHE_KEY = {};

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
    const payload = await verifyJwsAccessToken(token, {
      jwksFetch: fetchJwks,
      jwksCacheKey: JWKS_CACHE_KEY,
      verifyOptions: { issuer: OAUTH_ISSUER, audience: MCP_RESOURCE },
    });
    // `subjectType` is left at its "public" default, so `sub` is the user id
    // verbatim rather than a pairwise pseudonym.
    if (typeof payload.sub !== "string" || !payload.sub) {
      console.error("[MCP auth] token has no subject", { aud: payload.aud });
      return null;
    }
    return {
      userId: unsafeUserId(payload.sub),
      sessionId: typeof payload.sid === "string" ? payload.sid : null,
    };
  } catch (error) {
    // Every rejection reaches the client as a bare 401, so without this the
    // difference between "expired", "wrong audience" and "opaque token, not a
    // JWT" is invisible in production — which is exactly the hole that made a
    // misconfigured connector impossible to diagnose from the outside.
    console.error("[MCP auth] token rejected", {
      reason: error instanceof Error ? error.message : String(error),
      code:
        error && typeof error === "object" && "code" in error
          ? String((error as { code: unknown }).code)
          : undefined,
      // Claims only — never the token itself; this goes to `wrangler tail`.
      claims: unverifiedClaims(token),
    });
    return null;
  }
}

/**
 * Decode a JWT payload *without* verifying it, purely so a rejection can be
 * explained in logs. Returns null for anything that isn't a JWT at all — which
 * is itself the answer when a client was issued an opaque access token.
 */
function unverifiedClaims(
  token: string,
): { iss?: unknown; aud?: unknown; exp?: unknown } | null {
  const segments = token.split(".");
  if (segments.length !== 3 || !segments[1]) return null;
  try {
    const payload: unknown = JSON.parse(
      new TextDecoder().decode(
        Uint8Array.from(
          atob(segments[1].replace(/-/g, "+").replace(/_/g, "/")),
          (c) => c.charCodeAt(0),
        ),
      ),
    );
    if (typeof payload !== "object" || payload === null) return null;
    const { iss, aud, exp } = payload as Record<string, unknown>;
    return { iss, aud, exp };
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
