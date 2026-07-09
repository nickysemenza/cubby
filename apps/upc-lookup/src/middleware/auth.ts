import { createMiddleware } from "hono/factory";
import { getCookie } from "hono/cookie";
import type { Env } from "../types";

const ADMIN_COOKIE_NAME = "admin_session";

/**
 * Length-independent secret comparison: hashes both sides to a fixed-length
 * SHA-256 digest (so timing no longer varies with the *plaintext* secret's
 * length or shared-prefix length — a `!==` compare short-circuits on the
 * first differing char), then compares every digest byte via XOR-accumulate
 * rather than an early-exit `!==`, so the compare itself doesn't reintroduce
 * a timing signal. Defense-in-depth (single-user tool, CF edge jitter already
 * swamps char-level timing) — see audit F8.
 */
export async function secretsMatch(a: string, b: string): Promise<boolean> {
  const [digestA, digestB] = await Promise.all([sha256(a), sha256(b)]);
  let diff = 0;
  for (let i = 0; i < digestA.length; i++) {
    diff |= (digestA[i] ?? 0) ^ (digestB[i] ?? 0);
  }
  return diff === 0;
}

async function sha256(input: string): Promise<Uint8Array> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return new Uint8Array(digest);
}

/**
 * API key authentication middleware for programmatic API access.
 * Validates X-API-Key header against the configured API_KEY secret.
 */
export const apiKeyAuth = createMiddleware<{ Bindings: Env }>(
  async (c, next) => {
    const apiKey = c.req.header("X-API-Key");

    if (!apiKey) {
      return c.json({ error: "Missing API key", code: "MISSING_API_KEY" }, 401);
    }

    if (!(await secretsMatch(apiKey, c.env.API_KEY))) {
      return c.json({ error: "Invalid API key", code: "INVALID_API_KEY" }, 401);
    }

    await next();
  },
);

/**
 * Auth for the MCP endpoint. Accepts the API key via either the `X-API-Key`
 * header or `Authorization: Bearer <key>` (standard MCP clients send the latter).
 */
export const mcpAuth = createMiddleware<{ Bindings: Env }>(async (c, next) => {
  const authHeader = c.req.header("Authorization");
  const bearer = authHeader?.startsWith("Bearer ")
    ? authHeader.slice(7)
    : undefined;
  const apiKey = c.req.header("X-API-Key") ?? bearer;

  if (!apiKey) {
    return c.json({ error: "Missing API key", code: "MISSING_API_KEY" }, 401);
  }
  if (!(await secretsMatch(apiKey, c.env.API_KEY))) {
    return c.json({ error: "Invalid API key", code: "INVALID_API_KEY" }, 401);
  }

  await next();
});

/**
 * Cookie-based authentication middleware for admin UI.
 * Checks for valid session cookie, redirects to login if missing.
 */
export const adminAuth = createMiddleware<{ Bindings: Env }>(
  async (c, next) => {
    const sessionCookie = getCookie(c, ADMIN_COOKIE_NAME);

    if (!sessionCookie || !(await secretsMatch(sessionCookie, c.env.API_KEY))) {
      // Redirect to login page
      return c.redirect("/admin/login");
    }

    await next();
  },
);

export { ADMIN_COOKIE_NAME };
