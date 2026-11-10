import { apiKeyClient } from "@better-auth/api-key/client";
import { electronProxyClient } from "@better-auth/electron/proxy";
import { oauthProviderClient } from "@better-auth/oauth-provider/client";
import {
  APPLE_APP_IDENTITIES,
  type NativeCallbackScheme,
} from "@cubby/shared/apple-app-identity";
import { createAuthClient } from "better-auth/react";

export const createCubbyAuthClient = (callbackScheme: NativeCallbackScheme) =>
  createAuthClient({
    baseURL: import.meta.env.VITE_APP_URL || "",
    // oauthProviderClient is a fetch hook, not just typing: it copies the signed
    // `oauth_query` out of window.location.search into every non-GET auth
    // request, which is what carries authorize-flow state through the sign-in
    // and consent screens.
    plugins: [
      oauthProviderClient(),
      electronProxyClient({
        clientID: "cubby-native",
        protocol: callbackScheme,
        callbackPath: "/auth/callback",
      }),
      apiKeyClient(),
    ],
  });

export const authClient = createCubbyAuthClient(
  APPLE_APP_IDENTITIES.production.callbackScheme,
);
