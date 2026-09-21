import { apiKey } from "@better-auth/api-key";
import { electron } from "@better-auth/electron";
import { oauthProvider } from "@better-auth/oauth-provider";
import { betterAuth, type BetterAuthAdvancedOptions } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { bearer, jwt, openAPI } from "better-auth/plugins";
import { tanstackStartCookies } from "better-auth/tanstack-start";
import { and, eq } from "drizzle-orm";

import { env } from "~/env";
import { drizzle } from "~/server/db";
import * as schema from "~/server/db/auth.schema";

import { MCP_RESOURCE, OAUTH_ISSUER, OAUTH_SCOPES } from "./auth-constants";
import {
  authorizeGoogleUserInfo,
  isGoogleIdTokenOnlyRequest,
} from "./google-auth";
import { GMAIL_READONLY_SCOPE } from "./google-auth-constants";

const isDev = process.env.NODE_ENV !== "production";

const oauthResourceOptions = {
  resources: [{ identifier: MCP_RESOURCE, name: "Cubby MCP" }],
  enforcePerClientResources: true,
  // Claude does not send Better Auth's DCR `resources` extension, so link
  // Cubby's sole protected resource to every newly registered client.
  clientRegistrationDefaultResources: [MCP_RESOURCE],
  clientRegistrationAllowedResources: [MCP_RESOURCE],
} satisfies Partial<Parameters<typeof oauthProvider>[0]>;

/**
 * Better Auth 1.7 seeds configured resources from its plugin init hook. Worker
 * module initialization has no request-scoped database, so let the provider's
 * own lazy seed run on the first resource request instead. Keeping the options
 * after init preserves resource validation and dynamic-client defaults.
 */
function oauthProviderWithRequestScopedResourceSeed(
  options: Parameters<typeof oauthProvider>[0],
) {
  const plugin = oauthProvider(options);
  const init = plugin.init;
  return {
    ...plugin,
    init: init
      ? async (...args: Parameters<NonNullable<typeof init>>) => {
          const configuredResources = plugin.options.resources;
          plugin.options.resources = [];
          try {
            return await init(...args);
          } finally {
            plugin.options.resources = configuredResources;
          }
        }
      : undefined,
  };
}

async function getAuthorizedGoogleUserInfo(
  tokens: Parameters<typeof authorizeGoogleUserInfo>[0],
  clientId: string,
) {
  return authorizeGoogleUserInfo(
    tokens,
    clientId,
    async (accountId) => {
      const [existingAccount] = await drizzle
        .select({
          id: schema.account.id,
          refreshToken: schema.account.refreshToken,
          scope: schema.account.scope,
        })
        .from(schema.account)
        .where(
          and(
            eq(schema.account.providerId, "google"),
            eq(schema.account.accountId, accountId),
          ),
        )
        .limit(1);
      return existingAccount
        ? {
            id: existingAccount.id,
            hasRefreshToken: Boolean(existingAccount.refreshToken),
            scopes: existingAccount.scope?.split(",") ?? [],
          }
        : null;
    },
    async (id, scopes) => {
      // Better Auth intentionally omits scopes from returning social sign-in
      // updates, so persist Google's fresh authoritative grant here.
      await drizzle
        .update(schema.account)
        .set({ scope: scopes.join(",") })
        .where(eq(schema.account.id, id));
    },
  );
}

// Preview deploys (`wrangler versions upload`) each get a unique host, so a
// host-only session cookie forces a fresh login on every preview. CI injects
// COOKIE_DOMAIN via `--var` on preview uploads (see preview-cf.yaml); scoping
// the cookie to the configured preview suffix means one login carries to all
// previews. Unset in prod, which keeps a host-only cookie.
const previewCookieDomain = env.COOKIE_DOMAIN;

const advancedOptions: BetterAuthAdvancedOptions = {};
// E2E only: the production Worker artifact otherwise emits Secure cookies,
// which Playwright's Linux WebKit rejects over the harness's localhost HTTP.
if (env.INSECURE_AUTH_COOKIES === "true") {
  advancedOptions.useSecureCookies = false;
}
// Workers supplies the real address in this header; local dev has no CF proxy
// and keeps Better Auth's default resolution.
if (!isDev) {
  advancedOptions.ipAddress = { ipAddressHeaders: ["cf-connecting-ip"] };
}
if (previewCookieDomain) {
  advancedOptions.crossSubDomainCookies = {
    enabled: true,
    domain: previewCookieDomain,
  };
}

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
  account: {
    accountLinking: {
      trustedProviders: ["google"],
      // Google verifies the address in getGoogleUserInfo. The two existing
      // household users predate local email verification, so that verified
      // provider address is the ownership proof for the initial link.
      requireLocalEmailVerified: false,
    },
  },
  hooks: {
    before: createAuthMiddleware(async (context) => {
      if (isGoogleIdTokenOnlyRequest(context.path, context.body)) {
        throw new APIError("BAD_REQUEST", {
          code: "GOOGLE_AUTHORIZATION_CODE_REQUIRED",
          message: "Google sign-in requires the full authorization flow.",
        });
      }
    }),
  },
  // The E2E harness intentionally runs the production Worker artifact, where
  // Better Auth otherwise applies its process-local request limit to every
  // browser context as one local client. This flag is injected only by
  // e2e-global-setup; production and preview Workers retain rate limiting.
  rateLimit: { enabled: env.E2E_AUTH_TEST_MODE !== "true" },
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
      strategy: "compact",
      refreshCache: false,
    },
    // Disable the "session must be fresh" gate on sensitive endpoints
    // (list-sessions, change-password, delete-user). better-auth defaults it to
    // 24h and compares against the session's *createdAt*, which a refresh never
    // moves — so with 7-day sessions the account page's session list 403s
    // (SESSION_NOT_FRESH) six days out of seven. The protection it buys is
    // re-authentication before those operations; on a single-user instance
    // that's not worth a permanently broken settings page.
    freshAge: 0,
  },
  // The jwt plugin registers `GET /token` (mints a JWT for the current cookie
  // session). The OAuth token endpoint is `/oauth2/token`; nothing needs the
  // session-JWT one, so don't expose it.
  disabledPaths: ["/token"],
  plugins: [
    apiKey({
      configId: "http-api",
      references: "user",
      defaultPrefix: "cubby_",
      enableSessionForAPIKeys: false,
      rateLimit: { enabled: false },
    }),
    // Signs OAuth access tokens (and publishes JWKS at /api/auth/jwks) so
    // /api/mcp can verify them locally without a round trip to the DB.
    //
    // `issuer` must be set explicitly: oauthProvider derives its issuer path at
    // plugin-init time, before any request exists, and this repo leaves the
    // top-level `baseURL` unset (it's inferred per request). Without this the
    // provider does `new URL("")` during init and every auth request 500s.
    // Pinning it here also makes the `iss` claim deterministic — which is what
    // server/mcp/auth.ts verifies against.
    jwt({ disableSettingJwtHeader: true, jwt: { issuer: OAUTH_ISSUER } }),
    // OAuth 2.1 authorization server. This is how Claude connects to the MCP
    // endpoint — claude.ai custom connectors and Claude Code both do RFC 7591
    // dynamic client registration + PKCE against it. Unauthenticated
    // registration is required because neither can be given a client_id ahead
    // of time; registering is harmless on its own, since a token still requires
    // an interactive login + consent from the (single) account owner.
    oauthProviderWithRequestScopedResourceSeed({
      loginPage: "/auth/sign-in",
      consentPage: "/oauth/consent",
      allowDynamicClientRegistration: true,
      allowUnauthenticatedClientRegistration: true,
      scopes: OAUTH_SCOPES,
      ...oauthResourceOptions,
    }),
    // Scalar reference for the auth surface. Dev-only UI: the JSON schema
    // endpoint (/api/auth/open-api/generate-schema) stays available in both.
    openAPI(isDev ? {} : { disableDefaultReference: true }),
    electron({ clientID: "cubby-native" }),
    // Native clients (the Swift app) cannot hold ambient cookies. After a
    // sign-in the plugin echoes the session cookie's value in a
    // `set-auth-token` response header; the client then sends it back as
    // `Authorization: Bearer <token>` and the plugin injects it as the session
    // cookie before any `getSession` runs, so every existing call site accepts
    // it unchanged. `requireSignature` accepts only the signed `token.sig` form
    // the server itself hands out, so a raw session token from the DB cannot be
    // replayed as a bearer credential. Only the session-token cookie is
    // injected. Native API clients also replay the signed session-data cache;
    // the HTTP boundary binds that cache to the supplied bearer identity.
    bearer({ requireSignature: true }),
    tanstackStartCookies(), // Must be last
  ],
  advanced: advancedOptions,
  // In dev, trust any localhost/127.0.0.1 origin regardless of port so worktree
  // dev servers (which run on auto-assigned ports — see README "Worktrees") can
  // perform auth POSTs. The session cookie itself isn't port-scoped (RFC 6265) and
  // lives in the shared DB, so an existing login already carries across ports; this
  // only unblocks origin validation.
  //
  // In prod, trust the mobile scheme plus per-PR preview deploys (see
  // preview-cf.yaml). The wildcard is scoped to our account subdomain —
  // better-auth's `*` doesn't cross `/`, so this only widens the auth-origin
  // (CSRF) surface to those Workers. Email/password works on previews. The
  // custom domain is trusted automatically as the baseURL.
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
  socialProviders:
    env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
      ? {
          google: {
            clientId: env.GOOGLE_CLIENT_ID,
            clientSecret: env.GOOGLE_CLIENT_SECRET,
            accessType: "offline",
            prompt: "consent",
            scope: [GMAIL_READONLY_SCOPE],
            disableSignUp: true,
            getUserInfo: (tokens) =>
              getAuthorizedGoogleUserInfo(tokens, env.GOOGLE_CLIENT_ID!),
          },
        }
      : {},
});
