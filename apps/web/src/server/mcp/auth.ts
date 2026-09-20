import { userId } from "@cubby/schemas/identifiers";
import { verifyJwsAccessToken } from "better-auth/oauth2";

import { env } from "~/env";
import { auth, MCP_RESOURCE, OAUTH_ISSUER } from "~/lib/auth";
import {
  PURCHASE_AGENT_OAUTH_CLIENT_ID,
  verifyPurchaseAgentDelegation,
} from "~/server/purchase-import/agent-auth";

import {
  createMcpTokenVerifier,
  createUnauthorizedResponse,
  type VerifyMcpAccessToken,
} from "./auth-verifier";

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
/**
 * Verify the `Authorization: Bearer <jwt>` on an MCP request.
 *
 * Returns null for anything unauthenticated — missing header, malformed token,
 * bad signature, wrong issuer/audience, expired. Callers respond with
 * {@link unauthorizedResponse}.
 */
const verifyAccessToken: VerifyMcpAccessToken = async (token, options) =>
  verifyJwsAccessToken(token, options);

const verifyStandardMcpToken = createMcpTokenVerifier({
  verifyAccessToken,
  verificationOptions: {
    jwksFetch: fetchJwks,
    jwksCacheKey: JWKS_CACHE_KEY,
    verifyOptions: { issuer: OAUTH_ISSUER, audience: MCP_RESOURCE },
  },
  reportRejection: (message, detail) => console.error(message, detail),
});

/** Verify either a normal OAuth access token or a private, run-bound delegation. */
export const verifyMcpToken = async (request: Request) => {
  const authorization = request.headers.get("authorization");
  if (authorization?.startsWith("Bearer ")) {
    const token = authorization.slice("Bearer ".length).trim();
    const delegation = token
      ? await verifyPurchaseAgentDelegation(token, env.BETTER_AUTH_SECRET)
      : null;
    if (delegation) {
      return {
        userId: userId.parse(delegation.sub),
        sessionId: null,
        clientId: PURCHASE_AGENT_OAUTH_CLIENT_ID,
        purchaseAgentRunId: delegation.run_id,
        purchaseAgentGrantId: delegation.grant_id,
      };
    }
  }
  return await verifyStandardMcpToken(request);
};

/**
 * 401 that tells an MCP client where to start the OAuth flow. Without the
 * `WWW-Authenticate` header a client just reports a failed connection instead
 * of offering to sign in.
 */
export const unauthorizedResponse = createUnauthorizedResponse(MCP_RESOURCE);
