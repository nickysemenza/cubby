import { apiKeyClient } from "@better-auth/api-key/client";
import { expoClient } from "@better-auth/expo/client";
import { createAuthClient } from "better-auth/react";
import * as SecureStore from "expo-secure-store";
import { API_BASE_URL } from "./api-config";

// better-auth client for the Expo app.
// - expoClient persists the session cookie in the iOS Keychain (SecureStore) and
//   exposes authClient.getCookie(); `scheme` MUST match app.json's scheme and the
//   server's "cubby-mobile://" trustedOrigin. `storagePrefix` is required (omitting
//   it causes an infinite session-refetch loop per the docs).
// - apiKeyClient lets us mint a long-lived API key after sign-in; that key (not the
//   cookie) authenticates tRPC requests — see session-key.ts.
export const authClient = createAuthClient({
  baseURL: API_BASE_URL, // root origin, NOT /api/trpc — better-auth appends /api/auth
  plugins: [
    expoClient({
      scheme: "cubby-mobile",
      storagePrefix: "cubby",
      storage: SecureStore,
    }),
    apiKeyClient(),
  ],
});
