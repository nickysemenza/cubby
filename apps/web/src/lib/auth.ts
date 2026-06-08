import { apiKey } from "@better-auth/api-key";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { tanstackStartCookies } from "better-auth/tanstack-start";
import { drizzle } from "~/server/db";
import * as schema from "~/server/db/auth.schema";

const isDev = process.env.NODE_ENV !== "production";

export const auth = betterAuth({
  database: drizzleAdapter(drizzle, {
    provider: "pg",
    schema,
  }),
  emailAndPassword: {
    enabled: true,
    requireEmailVerification: false,
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
      rateLimit: { enabled: false },
    }),
    tanstackStartCookies(), // Must be last
  ],
  // The Expo app authenticates against this server: email/password sign-in from
  // the native client (Origin cubby-mobile://, trusted below) + an API key for
  // tRPC traffic. We deliberately do NOT add the @better-auth/expo server plugin
  // here — pulling it into the web app introduces a second peer-hashed
  // @better-auth/core copy that breaks the plugin types under pnpm, and its main
  // job (trusting the app scheme; OAuth deep-link rewrites we don't use) is
  // already covered by the cubby-mobile:// trustedOrigin. The @better-auth/expo
  // CLIENT plugin lives in the mobile app and handles SecureStore cookie storage.
  trustedOrigins: [
    "cubby-mobile://",
    ...(isDev
      ? [
          "http://localhost:3000",
          "http://127.0.0.1:3000",
          // Expo dev: Metro serves over the exp:// scheme.
          "exp://",
          "exp://**",
          "exp://192.168.*.*:*/**",
        ]
      : []),
  ],
  socialProviders: {},
});
