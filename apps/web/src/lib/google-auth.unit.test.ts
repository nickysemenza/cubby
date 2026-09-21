import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  authorizeGoogleUserInfo,
  getGoogleUserInfo,
  isGoogleIdTokenOnlyRequest,
} from "./google-auth";
import { GMAIL_READONLY_SCOPE } from "./google-auth-constants";

const completeTokens = {
  accessToken: "access-token",
  idToken: "id-token",
  refreshToken: "refresh-token",
  scopes: ["openid", "email", GMAIL_READONLY_SCOPE],
};

const verifyIdToken = vi.fn();

describe("Google authentication policy", () => {
  beforeEach(() => {
    verifyIdToken.mockReset();
    verifyIdToken.mockResolvedValue({
      aud: "web-client",
      email: "member@example.test",
      email_verified: true,
      exp: 2_000_000_000,
      iat: 1_999_999_000,
      iss: "https://accounts.google.com",
      sub: "google-account-id",
    });
  });

  it("rejects partial consent before verifying or returning an identity", async () => {
    const result = await getGoogleUserInfo(
      { ...completeTokens, scopes: ["openid", "email"] },
      "web-client",
      verifyIdToken,
    );

    expect(result).toBeNull();
    expect(verifyIdToken).not.toHaveBeenCalled();
  });

  it("requires Google's verified email claim", async () => {
    verifyIdToken.mockResolvedValue({
      email: "member@example.test",
      email_verified: false,
      sub: "google-account-id",
    });

    await expect(
      getGoogleUserInfo(completeTokens, "web-client", verifyIdToken),
    ).resolves.toBeNull();
  });

  it("accepts verified identity without optional profile claims", async () => {
    await expect(
      getGoogleUserInfo(completeTokens, "web-client", verifyIdToken),
    ).resolves.toMatchObject({
      user: {
        email: "member@example.test",
        emailVerified: true,
        name: "member@example.test",
      },
      data: { sub: "google-account-id" },
    });
  });

  it("preserves an omitted refresh token only for the same stored Google account", async () => {
    const loadStoredAccount = vi.fn(async (accountId: string) =>
      accountId === "google-account-id"
        ? {
            id: "stored-account-id",
            hasRefreshToken: true,
            scopes: ["openid", "email"],
          }
        : null,
    );
    const persistScopes = vi.fn(async () => undefined);

    await expect(
      authorizeGoogleUserInfo(
        { ...completeTokens, refreshToken: undefined },
        "web-client",
        loadStoredAccount,
        persistScopes,
        verifyIdToken,
      ),
    ).resolves.toMatchObject({ data: { sub: "google-account-id" } });
    expect(loadStoredAccount).toHaveBeenCalledWith("google-account-id");
    expect(persistScopes).toHaveBeenCalledWith("stored-account-id", [
      "openid",
      "email",
      GMAIL_READONLY_SCOPE,
    ]);

    loadStoredAccount.mockResolvedValue({
      id: "stored-account-id",
      hasRefreshToken: false,
      scopes: [],
    });
    await expect(
      authorizeGoogleUserInfo(
        { ...completeTokens, refreshToken: undefined },
        "web-client",
        loadStoredAccount,
        persistScopes,
        verifyIdToken,
      ),
    ).resolves.toBeNull();
  });

  it("rejects the Google ID-token-only sign-in and linking paths", () => {
    expect(
      isGoogleIdTokenOnlyRequest("/sign-in/social", {
        provider: "google",
        idToken: { token: "token" },
      }),
    ).toBe(true);
    expect(
      isGoogleIdTokenOnlyRequest("/link-social", {
        provider: "google",
        idToken: { token: "token" },
      }),
    ).toBe(true);
    expect(
      isGoogleIdTokenOnlyRequest("/sign-in/social", { provider: "google" }),
    ).toBe(false);
  });
});
