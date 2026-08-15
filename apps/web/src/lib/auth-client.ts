import { oauthProviderClient } from "@better-auth/oauth-provider/client";
import { passkeyClient } from "@better-auth/passkey/client";
import { createAuthClient } from "better-auth/react";

export const authClient = createAuthClient({
  baseURL: import.meta.env.VITE_APP_URL || "",
  // oauthProviderClient is a fetch hook, not just typing: it copies the signed
  // `oauth_query` out of window.location.search into every non-GET auth
  // request, which is what carries authorize-flow state through the sign-in
  // and consent screens.
  plugins: [oauthProviderClient(), passkeyClient()],
});
