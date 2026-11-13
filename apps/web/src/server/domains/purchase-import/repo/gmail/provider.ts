import type { UserId } from "@cubby/schemas/identifiers";

import { env } from "~/env";
import { getGmailOAuthCredentials } from "~/server/cf-env";
import type { Database } from "~/server/db";
import {
  GmailApiError,
  type GmailProvider,
} from "~/server/domains/purchase-import/repo/gmail/types";
import { inWorkContext } from "~/server/kernel/context";
import { WorkDeferredError } from "~/server/kernel/work-errors";
import { localGoogleProviderOrigin } from "~/server/lib/local-google-provider-origin";

import {
  createBetterAuthGmailAccountStore,
  readGmailProviderRetryAt,
  recordGmailProviderRetryAt,
} from "./persistence";
import { createGmailProviderFactory } from "./tokens";

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
  expectedMailboxId?: string,
): Promise<GmailProvider> {
  const worker = getGmailOAuthCredentials();
  const clientId = worker?.clientId ?? env.GOOGLE_CLIENT_ID;
  const clientSecret = worker?.clientSecret ?? env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret)
    throw new Error("Google OAuth is not configured for Gmail.");
  const provider = await createGmailProviderFactory({
    store: createBetterAuthGmailAccountStore(db, expectedMailboxId),
    clientId,
    clientSecret,
    ...localGmailEndpoints(),
  })(userId);
  const identity = { userId, mailboxId: expectedMailboxId };
  const guarded = async <T>(request: () => Promise<T>): Promise<T> => {
    const until = await readGmailProviderRetryAt(db, identity);
    if (until) {
      const error = new GmailApiError({
        status: 429,
        message: "Gmail provider is waiting for shared capacity",
        retryAt: until.getTime(),
      });
      if (!inWorkContext()) throw error;
      const deferred = new WorkDeferredError(
        error.message,
        until,
        "rate_limit",
      );
      deferred.cause = error;
      throw deferred;
    }
    try {
      return await request();
    } catch (error) {
      if (!(error instanceof GmailApiError) || error.retryAt === undefined)
        throw error;
      const next = new Date(error.retryAt);
      await recordGmailProviderRetryAt(db, { ...identity, until: next });
      if (!inWorkContext()) throw error;
      const deferred = new WorkDeferredError(error.message, next, "rate_limit");
      deferred.cause = error;
      throw deferred;
    }
  };
  return {
    getProfile: () => guarded(() => provider.getProfile()),
    listMessages: (options) => guarded(() => provider.listMessages(options)),
    listHistory: (options) => guarded(() => provider.listHistory(options)),
    getMessage: (id) => guarded(() => provider.getMessage(id)),
    getAttachment: (id, attachmentId) =>
      guarded(() => provider.getAttachment(id, attachmentId)),
  };
}
