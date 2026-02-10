import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { apiKey } from "better-auth/plugins";
import { tanstackStartCookies } from "better-auth/tanstack-start";
import { drizzle } from "~/server/db";
import * as schema from "~/server/db/auth.schema";

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
    }),
    tanstackStartCookies(), // Must be last
  ],
  trustedOrigins: ["cubby-mobile://"],
  socialProviders: {},
});
