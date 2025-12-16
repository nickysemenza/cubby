import { createMiddleware } from "hono/factory";
import { getCookie } from "hono/cookie";
import type { Env } from "../types";

const ADMIN_COOKIE_NAME = "admin_session";

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

    if (apiKey !== c.env.API_KEY) {
      return c.json({ error: "Invalid API key", code: "INVALID_API_KEY" }, 401);
    }

    await next();
  }
);

/**
 * Cookie-based authentication middleware for admin UI.
 * Checks for valid session cookie, redirects to login if missing.
 */
export const adminAuth = createMiddleware<{ Bindings: Env }>(
  async (c, next) => {
    const sessionCookie = getCookie(c, ADMIN_COOKIE_NAME);

    if (!sessionCookie || sessionCookie !== c.env.API_KEY) {
      // Redirect to login page
      return c.redirect("/admin/login");
    }

    await next();
  }
);

export { ADMIN_COOKIE_NAME };
