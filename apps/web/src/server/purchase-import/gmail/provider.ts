import type { UserId } from "@cubby/schemas/identifiers";

import { env } from "~/env";
import { localGoogleProviderOrigin } from "~/lib/e2e-google-provider";
import { getGmailOAuthCredentials } from "~/server/cf-env";
import type { Database } from "~/server/db";

import { createBetterAuthGmailAccountStore } from "./persistence";
import { createGmailProviderFactory } from "./tokens";
import type { GmailProvider } from "./types";

/** The local Google provider's Gmail and token endpoints during E2E. */
const localGmailEndpoints = () => {
  const origin = localGoogleProviderOrigin(
    env.E2E_AUTH_TEST_MODE,
    env.E2E_GOOGLE_PROVIDER_URL,
  );
  return {
    gmailBaseUrl: origin ? `${origin}/gmail/v1` : undefined,
    tokenEndpoint: origin ? `${origin}/token` : undefined,
  };
};

/** True when the Worker or local env carries Google OAuth credentials. */
export const gmailOAuthConfigured = (): boolean => {
  const worker = getGmailOAuthCredentials();
  return Boolean(
    (worker?.clientId ?? env.GOOGLE_CLIENT_ID) &&
    (worker?.clientSecret ?? env.GOOGLE_CLIENT_SECRET),
  );
};

/** A member's Gmail API client, refreshing their stored Google token as needed. */
export async function gmailProviderForUser(
  db: Database,
  userId: UserId | string,
): Promise<GmailProvider> {
  const worker = getGmailOAuthCredentials();
  const clientId = worker?.clientId ?? env.GOOGLE_CLIENT_ID;
  const clientSecret = worker?.clientSecret ?? env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret)
    throw new Error("Google OAuth is not configured for Gmail.");
  return createGmailProviderFactory({
    store: createBetterAuthGmailAccountStore(db),
    clientId,
    clientSecret,
    ...localGmailEndpoints(),
  })(userId);
}
