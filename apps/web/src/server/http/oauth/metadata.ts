import { auth } from "~/lib/auth";
import { MCP_RESOURCE, OAUTH_ISSUER, OAUTH_SCOPES } from "~/lib/auth-constants";

/**
 * Discovery documents for the OAuth 2.1 authorization server and the MCP
 * resource server.
 *
 * These are public, unauthenticated metadata documents, and MCP clients fetch
 * them from the *frontend* (the MCP Inspector and browser-based clients both
 * do), so they need permissive CORS or discovery fails before it starts.
 */
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "*",
} as const satisfies Readonly<Record<string, string>>;

function withCors(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(CORS_HEADERS)) {
    headers.set(key, value);
  }
  return new Response(response.body, { status: response.status, headers });
}

export function preflightHandler() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

/**
 * Serve a better-auth discovery document from a root-level `/.well-known/…`
 * alias by replaying the request at its canonical path under the auth handler.
 *
 * Not `oauthProviderAuthServerMetadata(auth)`: that helper calls `auth.api.*`
 * directly, which never populates `ctx.baseURL`, so every endpoint in the
 * document comes back as a bare path (`/oauth2/authorize`) instead of an
 * absolute URL — RFC 8414 requires absolute, and clients choke on it. Going
 * through `auth.handler` gets better-auth's own per-request origin inference,
 * which is also what keeps dev and prod working off one code path.
 */
function proxyToAuthHandler(canonicalPath: string) {
  return async ({ request }: { request: Request }) => {
    const url = new URL(request.url);
    url.pathname = canonicalPath;
    return withCors(
      await auth.handler(
        new Request(url, { method: request.method, headers: request.headers }),
      ),
    );
  };
}

/** RFC 8414 authorization server metadata. */
export const authServerMetadataHandler = proxyToAuthHandler(
  "/api/auth/.well-known/oauth-authorization-server",
);

/** OpenID Connect discovery metadata. */
export const openIdConfigHandler = proxyToAuthHandler(
  "/api/auth/.well-known/openid-configuration",
);

/**
 * RFC 9728 protected resource metadata for /api/mcp.
 *
 * Hand-rolled rather than using the plugin's `oauthProviderResourceClient`,
 * which derives everything from `auth.options.baseURL` — deliberately unset
 * here so the rest of better-auth can infer the origin per request. Advertising
 * the same constants the server persists and validates (rather than the request
 * origin) means the `resource` a client asks for is always the configured
 * protected resource.
 */
export function protectedResourceHandler() {
  return withCors(
    Response.json({
      resource: MCP_RESOURCE,
      authorization_servers: [OAUTH_ISSUER],
      scopes_supported: OAUTH_SCOPES,
      bearer_methods_supported: ["header"],
    }),
  );
}
