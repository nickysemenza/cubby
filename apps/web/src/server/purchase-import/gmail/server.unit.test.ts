import { describe, expect, it, vi } from "vitest";

import type { Database } from "~/server/db";

import { runGmailHourlySync } from "./hourly";
import {
  createGmailAccessTokenResolver,
  GmailAuthorizationError,
  type GmailAccountTokenRecord,
} from "./tokens";

const NOW = new Date("2026-09-19T12:00:00.000Z");

const account = (
  patch: Partial<GmailAccountTokenRecord> = {},
): GmailAccountTokenRecord => ({
  userId: "user-placeholder",
  providerId: "google",
  accessToken: "access-old",
  refreshToken: "refresh-placeholder",
  accessTokenExpiresAt: new Date("2026-09-19T11:00:00.000Z"),
  ...patch,
});

describe("Gmail Better Auth token boundary", () => {
  it("refreshes expired Google credentials, persists rotation, and returns expiry", async () => {
    let stored = account();
    const update = vi.fn(async (_userId, patch) => {
      stored = {
        ...stored,
        accessToken: patch.accessToken,
        refreshToken: patch.refreshToken ?? stored.refreshToken,
        accessTokenExpiresAt: patch.accessTokenExpiresAt,
      };
    });
    const requests: { url: string; body: string }[] = [];
    const resolve = createGmailAccessTokenResolver({
      store: {
        findGoogleAccount: async () => stored,
        updateGoogleAccount: update,
      },
      clientId: "client-placeholder",
      clientSecret: "secret-placeholder",
      tokenEndpoint: "https://oauth.test/token",
      now: () => NOW,
      fetcher: async (input, init) => {
        requests.push({ url: String(input), body: String(init?.body) });
        return Response.json({
          access_token: "access-new",
          expires_in: 1800,
          refresh_token: "refresh-rotated",
        });
      },
    });

    await expect(resolve("user-placeholder")).resolves.toEqual({
      accessToken: "access-new",
      accessTokenExpiresAt: new Date("2026-09-19T12:30:00.000Z"),
    });
    expect(requests).toEqual([
      {
        url: "https://oauth.test/token",
        body: expect.stringContaining("grant_type=refresh_token"),
      },
    ]);
    expect(update).toHaveBeenCalledOnce();
    expect(stored.refreshToken).toBe("refresh-rotated");
  });

  it("reuses a fresh access token without touching the refresh endpoint", async () => {
    const fetcher = vi.fn();
    const resolve = createGmailAccessTokenResolver({
      store: {
        findGoogleAccount: async () =>
          account({
            accessToken: "access-fresh",
            accessTokenExpiresAt: new Date("2026-09-19T14:00:00.000Z"),
          }),
        updateGoogleAccount: async () => undefined,
      },
      clientId: "client-placeholder",
      clientSecret: "secret-placeholder",
      now: () => NOW,
      fetcher,
    });

    await expect(resolve("user-placeholder")).resolves.toMatchObject({
      accessToken: "access-fresh",
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("reports reconnect when Better Auth has no refresh token", async () => {
    const resolve = createGmailAccessTokenResolver({
      store: {
        findGoogleAccount: async () => account({ refreshToken: null }),
        updateGoogleAccount: async () => undefined,
      },
      clientId: "client-placeholder",
      clientSecret: "secret-placeholder",
      now: () => NOW,
    });

    await expect(resolve("user-placeholder")).rejects.toBeInstanceOf(
      GmailAuthorizationError,
    );
  });
});

describe("Gmail hourly orchestration", () => {
  it("sorts targets, persists each completed cursor, and isolates one failure", async () => {
    const syncOrder: string[] = [];
    const persisted: string[] = [];
    // SAFETY: The orchestration test replaces every callback that touches the
    // database, so this sentinel is never dereferenced.
    const database = {} as Database;
    const summary = await runGmailHourlySync({
      db: database,
      listTargets: async () => [
        {
          ledgerPartyId: "LP-ZZZZ",
          userId: "user-z",
          mailboxId: "mailbox-z",
          bootstrap: { knownSenders: [] },
        },
        {
          ledgerPartyId: "LP-AAAA",
          userId: "user-a",
          mailboxId: "mailbox-a",
          bootstrap: { knownSenders: [] },
        },
      ],
      loadCursor: async () => ({ historyId: null }),
      providerForUser: async (userId) => {
        if (userId === "user-z") throw new Error("authorization required");
        // SAFETY: The injected sync callback never calls provider methods.
        return {} as never;
      },
      sync: async (_provider, options) => {
        syncOrder.push(options.mailboxId);
        return {
          mode: "bootstrap",
          reason: "first_sync",
          cursor: { historyId: "100" },
          messages: [],
          events: [],
          attachments: [],
        };
      },
      persist: async (_db, input) => {
        persisted.push(input.ledgerPartyId);
        return { messageIds: [], eventCount: 0, attachmentCount: 0 };
      },
    });

    expect(syncOrder).toEqual(["mailbox-a"]);
    expect(persisted).toEqual(["LP-AAAA"]);
    expect(summary).toEqual({
      attempted: 2,
      succeeded: 1,
      failures: [
        {
          ledgerPartyId: "LP-ZZZZ",
          userId: "user-z",
          error: "authorization required",
        },
      ],
    });
  });

  it("advances the cursor only after classified mail processing succeeds", async () => {
    // SAFETY: Every database callback is injected for this orchestration test.
    const database = {} as Database;
    const order: string[] = [];
    const result = {
      mode: "incremental" as const,
      reason: "incremental" as const,
      cursor: { historyId: "200" },
      messages: [],
      events: [],
      attachments: [],
    };
    const base = {
      db: database,
      listTargets: async () => [
        {
          ledgerPartyId: "LP-AAAA",
          userId: "user-a",
          mailboxId: "mailbox-a",
          bootstrap: { knownSenders: [] },
        },
      ],
      loadCursor: async () => ({ historyId: "100" }),
      // SAFETY: The injected sync callback never calls provider methods.
      providerForUser: async () => ({}) as never,
      sync: async () => result,
      persist: async (_db: Database, input: { advanceCursor?: boolean }) => {
        order.push(`persist:${String(input.advanceCursor)}`);
        return { messageIds: ["message-1"], eventCount: 0, attachmentCount: 0 };
      },
      advanceCursor: async () => {
        order.push("advance");
      },
    };

    const failed = await runGmailHourlySync({
      ...base,
      processMessages: async () => {
        order.push("process-failed");
        throw new Error("classification failed");
      },
    });
    expect(failed.succeeded).toBe(0);
    expect(order).toEqual(["persist:false", "process-failed"]);

    order.length = 0;
    const succeeded = await runGmailHourlySync({
      ...base,
      processMessages: async () => {
        order.push("process-complete");
        return 1;
      },
    });
    expect(succeeded.succeeded).toBe(1);
    expect(order).toEqual(["persist:false", "process-complete", "advance"]);
  });
});
