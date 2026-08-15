import { oauthProviderClient } from "@better-auth/oauth-provider/client";
import { passkeyClient } from "@better-auth/passkey/client";
import { inferAdditionalFields } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

export const authClient = createAuthClient({
  baseURL: import.meta.env.VITE_APP_URL || "",
  // oauthProviderClient is a fetch hook, not just typing: it copies the signed
  // `oauth_query` out of window.location.search into every non-GET auth
  // request, which is what carries authorize-flow state through the sign-in
  // and consent screens.
  plugins: [
    // Declared inline rather than as `inferAdditionalFields<typeof auth>()`:
    // that form needs `~/lib/auth`, which imports drizzle and the DB. Even as a
    // type-only import it's a foot-gun next to `assertNoServerCodeInClient`, and
    // one field isn't worth the coupling. Keep in sync with `user.additionalFields`
    // in lib/auth.ts.
    inferAdditionalFields({
      user: { calendarFeedToken: { type: "string", required: false } },
    }),
    oauthProviderClient(),
    passkeyClient(),
  ],
});
