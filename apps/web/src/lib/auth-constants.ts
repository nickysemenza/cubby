const isDev = process.env.NODE_ENV !== "production";

// The OAuth server needs a concrete origin at config time (unlike the rest of
// Better Auth, which infers baseURL per request). Preview deploys get unique
// hosts that cannot be enumerated here, so OAuth-MCP is production + local dev
// only; previews keep the rest of auth.
export const APP_ORIGIN = isDev
  ? "http://localhost:3000"
  : "https://cubby.nickysemenza.com";

/** The `aud` an MCP access token must carry. Also the RFC 9728 `resource`. */
export const MCP_RESOURCE = `${APP_ORIGIN}/api/mcp`;

/** Issuer / `iss` of MCP access tokens, and the RFC 8414 authorization server. */
export const OAUTH_ISSUER = `${APP_ORIGIN}/api/auth`;

// `offline_access` is load-bearing: it mints the refresh token that lets a
// non-interactive Claude Code run keep working after the interactive login.
export const OAUTH_SCOPES = ["openid", "profile", "email", "offline_access"];
