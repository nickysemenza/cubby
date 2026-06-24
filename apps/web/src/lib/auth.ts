import { apiKey } from "@better-auth/api-key";
import { passkey } from "@better-auth/passkey";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { tanstackStartCookies } from "better-auth/tanstack-start";
import { env } from "~/env";
import { drizzle } from "~/server/db";
import * as schema from "~/server/db/auth.schema";

const isDev = process.env.NODE_ENV !== "production";

// Preview deploys (`wrangler versions upload`) each get a unique host
// `<prefix>-cubby.nicky.workers.dev`, so a host-only session cookie forces a
// fresh login on every preview. CI injects COOKIE_DOMAIN=.nicky.workers.dev via
// `--var` on preview uploads (see ci.yaml `preview-cf`); scoping the cookie to
// the whole account subdomain means one login on any preview carries to all of
// them. Unset in prod (custom domain) — prod keeps a host-only cookie on
// cubby.nickysemenza.com, unchanged. Passkeys still won't work on previews
// (rpID is bound to cubby.nickysemenza.com below); this only covers the session.
const previewCookieDomain = env.COOKIE_DOMAIN;

export const auth = betterAuth({
  database: drizzleAdapter(drizzle, {
    provider: "pg",
    schema,
  }),
  emailAndPassword: {
    enabled: true,
    requireEmailVerification: false,
    // Personal instance: signup closed. Set ALLOW_SIGNUP=true temporarily to
    // open it (e.g. adding a second account), then unset.
    disableSignUp: env.ALLOW_SIGNUP !== "true",
  },
  session: {
    // Read session validity from a short-lived signed cookie instead of hitting
    // the DB on every getSession. Removes the serialized session+user lookups
    // that prefix every authenticated request. Works on CF Workers — it's just
    // a signed cookie, no KV/DB. Trade-off: session/user data (e.g. profile
    // edits, revocation) can be up to maxAge stale; pass ?disableCookieCache to
    // force a fresh read where freshness matters.
    cookieCache: {
      enabled: true,
      maxAge: 5 * 60, // 5 minutes
    },
  },
  plugins: [
    apiKey({
      enableSessionForAPIKeys: true,
      // Rate limiting is deliberately OFF. better-auth's default when enabled is
      // a punishing 10 requests / 24h per key (@better-auth/api-key index.mjs:
      // timeWindow 1e3*60*60*24, maxRequests 10) — a single Claude MCP
      // conversation fires far more tool calls than that, so the default would
      // lock the (single) owner out almost immediately. There's no abuse vector
      // worth throttling on a single-user instance; if a custom limit is ever
      // wanted, set { enabled: true, maxRequests, timeWindow } here AND verify
      // headroom for a full MCP session before deploying (lockout risk).
      rateLimit: { enabled: false },
    }),
    passkey({
      rpID: isDev ? "localhost" : "cubby.nickysemenza.com",
      rpName: "Cubby",
      origin: isDev
        ? "http://localhost:3000"
        : "https://cubby.nickysemenza.com",
    }),
    tanstackStartCookies(), // Must be last
  ],
  advanced: previewCookieDomain
    ? {
        crossSubDomainCookies: {
          enabled: true,
          domain: previewCookieDomain,
        },
      }
    : undefined,
  // In dev, trust any localhost/127.0.0.1 origin regardless of port so worktree
  // dev servers (which run on auto-assigned ports — see README "Worktrees") can
  // perform auth POSTs. The session cookie itself isn't port-scoped (RFC 6265) and
  // lives in the shared DB, so an existing login already carries across ports; this
  // only unblocks origin validation.
  //
  // In prod, trust the mobile scheme plus per-PR preview deploys served at
  // https://<prefix>-cubby.nicky.workers.dev (see ci.yaml `preview-cf`). The
  // wildcard is scoped to our own account subdomain — better-auth's `*` doesn't
  // cross `/`, so this only widens the auth-origin (CSRF) surface to workers on
  // nicky.workers.dev. Passkeys still won't work on previews (rpID is bound to
  // cubby.nickysemenza.com above); email/password does. The custom domain is the
  // deployed origin, trusted automatically as the baseURL.
  trustedOrigins: isDev
    ? (request) => {
        const base = [
          "cubby-mobile://",
          "http://localhost:3000",
          "http://127.0.0.1:3000",
        ];
        const origin = request?.headers.get("origin"); // undefined on init/auth.api
        const isLocal =
          origin && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
        return isLocal ? [...base, origin] : base;
      }
    : ["cubby-mobile://", "https://*.nicky.workers.dev"],
  socialProviders: {},
});
