import { describe, expect, it, vi } from "vitest";

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
