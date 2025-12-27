import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { apiKey, organization } from "better-auth/plugins";
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
    organization({
      // TODO: Wire up real email delivery later
      sendInvitationEmail: async (data) => {
        // Placeholder until email service is configured
        if (process.env.NODE_ENV === "development") {
          console.log("[better-auth] send invitation:", data.email);
        }
      },
    }),
    apiKey({
      enableSessionForAPIKeys: true,
    }),
    tanstackStartCookies(), // Must be last
  ],
  socialProviders: {},
});
