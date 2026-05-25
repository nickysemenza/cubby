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
  plugins: [
    apiKey({
      enableSessionForAPIKeys: true,
      rateLimit: { enabled: false },
    }),
    tanstackStartCookies(), // Must be last
  ],
  trustedOrigins: [
    "cubby-mobile://",
    ...(isDev ? ["http://localhost:3000", "http://127.0.0.1:3000"] : []),
  ],
  socialProviders: {},
});
