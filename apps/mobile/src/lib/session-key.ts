import * as SecureStore from "expo-secure-store";
import { authClient } from "./auth-client";

// We authenticate tRPC traffic with a better-auth API key (sent as x-api-key),
// reusing the server's proven apiKey({ enableSessionForAPIKeys: true }) path with
// zero tRPC-route changes. The cookie session (from @better-auth/expo) is used
// only for sign-in/account flows and to mint this key.
//
// SecureStore (iOS Keychain) values are capped at ~2KB — an API key is tiny, so
// this is the right place for it.
const API_KEY_STORE = "cubby_api_key";

export function getStoredApiKey(): Promise<string | null> {
  return SecureStore.getItemAsync(API_KEY_STORE);
}

/**
 * Ensure a tRPC API key exists for this device, minting one (via the active
 * cookie session) and persisting it on first call. Returns null if minting fails
 * (e.g. not signed in).
 */
export async function ensureApiKey(): Promise<string | null> {
  const existing = await SecureStore.getItemAsync(API_KEY_STORE);
  if (existing) return existing;

  const res = await authClient.apiKey.create({ name: "cubby-mobile" });
  const key = res.data?.key ?? null;
  if (key) await SecureStore.setItemAsync(API_KEY_STORE, key);
  return key;
}

export async function clearApiKey(): Promise<void> {
  await SecureStore.deleteItemAsync(API_KEY_STORE);
}
