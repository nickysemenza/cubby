import { betterAuth } from "better-auth";
import { organization, apiKey } from "better-auth/plugins";
import { nextCookies } from "better-auth/next-js";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
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
    nextCookies(),
  ],
  socialProviders: {},
});
