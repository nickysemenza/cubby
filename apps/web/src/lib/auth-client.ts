import { apiKeyClient } from "@better-auth/api-key/client";
import { electronProxyClient } from "@better-auth/electron/proxy";
import { oauthProviderClient } from "@better-auth/oauth-provider/client";
import { createAuthClient } from "better-auth/react";

export const authClient = createAuthClient({
  baseURL: import.meta.env.VITE_APP_URL || "",
  // oauthProviderClient is a fetch hook, not just typing: it copies the signed
  // `oauth_query` out of window.location.search into every non-GET auth
  // request, which is what carries authorize-flow state through the sign-in
  // and consent screens.
  plugins: [
    oauthProviderClient(),
    electronProxyClient({
      clientID: "cubby-native",
      protocol: "cubby",
      callbackPath: "/auth/callback",
    }),
    apiKeyClient(),
  ],
  fetchOptions: {
    onRequest(context) {
      // The installed account UI omits configId; scope every management request.
      if (new URL(context.url).pathname.includes("/api-key/")) {
        if (context.method === "GET") {
          const url = new URL(context.url);
          url.searchParams.set("configId", "http-api");
          context.url = url.toString();
        } else {
          const body = JSON.parse(context.body || "{}");
          context.body = JSON.stringify({ ...body, configId: "http-api" });
        }
      }
      return context;
    },
  },
});
