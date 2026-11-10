import { queryOptions } from "@tanstack/react-query";

import { authClient } from "~/lib/auth-client";

/** The API-key plugin config this account page manages; see `apiKey()` in server/http/auth.ts. */
export const API_KEY_CONFIG_ID = "http-api";

/** Better Auth's client returns `{ data, error }`; queries and mutations want a throw. */
export async function unwrapAuth<T>(
  call: Promise<
    | { data: T; error: null }
    | { data: null; error: { message?: string | undefined } }
  >,
): Promise<T> {
  const result = await call;
  if (result.error)
    throw new Error(result.error.message || "Account request failed", {
      cause: result.error,
    });
  // SAFETY: Better Auth's result union pairs a null error with present data.
  return result.data as T;
}

export const authAccountsQuery = queryOptions({
  // Shared with the Settings Gmail access control, so linking in either place updates both.
  queryKey: ["auth", "accounts"],
  queryFn: async () => (await unwrapAuth(authClient.listAccounts())) ?? [],
});

export const authSessionsQuery = queryOptions({
  queryKey: ["auth", "sessions"],
  queryFn: async () => (await unwrapAuth(authClient.listSessions())) ?? [],
});

export const authApiKeysQuery = queryOptions({
  queryKey: ["auth", "api-keys"],
  queryFn: async () =>
    (
      await unwrapAuth(
        authClient.apiKey.list({ query: { configId: API_KEY_CONFIG_ID } }),
      )
    )?.apiKeys ?? [],
});
