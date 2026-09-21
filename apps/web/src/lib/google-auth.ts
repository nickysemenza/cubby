import {
  type GoogleProfile,
  verifyGoogleIdToken,
} from "better-auth/social-providers";
import { z } from "zod";

import { GMAIL_READONLY_SCOPE } from "./google-auth-constants";

type GoogleOAuthTokens = {
  accessToken?: string;
  idToken?: string;
  refreshToken?: string;
  scopes?: string[];
};

type GoogleIdTokenVerifier = typeof verifyGoogleIdToken;

export type StoredGoogleAccountAccess = {
  id: string;
  hasRefreshToken: boolean;
  scopes: readonly string[];
};

const googleProfile = (audience: string) =>
  z
    .object({
      aud: z
        .union([z.string(), z.array(z.string())])
        .transform((value) =>
          Array.isArray(value) ? (value[0] ?? audience) : value,
        )
        .default(audience),
      azp: z.string().default(audience),
      email: z.email(),
      email_verified: z.literal(true),
      exp: z.number().default(0),
      family_name: z.string().default(""),
      given_name: z.string().default(""),
      iat: z.number().default(0),
      iss: z.string().default("https://accounts.google.com"),
      name: z.string().optional(),
      picture: z.string().default(""),
      sub: z.string(),
    })
    .passthrough();

export function hasGmailReadonlyScope(
  scopes: readonly string[] | null | undefined,
) {
  return scopes?.includes(GMAIL_READONLY_SCOPE) === true;
}

/**
 * Google identity and Gmail authorization are one Cubby connection. Validate
 * both before Better Auth reaches its account/session write path.
 */
export async function getGoogleUserInfo(
  tokens: GoogleOAuthTokens,
  audience: string,
  verifyIdToken: GoogleIdTokenVerifier = verifyGoogleIdToken,
) {
  if (
    !tokens.accessToken ||
    !tokens.idToken ||
    !hasGmailReadonlyScope(tokens.scopes)
  ) {
    return null;
  }

  const claims = await verifyIdToken({
    token: tokens.idToken,
    audience,
  });
  const profile = googleProfile(audience).safeParse(claims);
  if (!profile.success) return null;

  const providerProfile: GoogleProfile = {
    aud: profile.data.aud,
    azp: profile.data.azp,
    email: profile.data.email,
    email_verified: true,
    exp: profile.data.exp,
    family_name: profile.data.family_name,
    given_name: profile.data.given_name,
    iat: profile.data.iat,
    iss: profile.data.iss,
    name: profile.data.name ?? profile.data.email,
    picture: profile.data.picture,
    sub: profile.data.sub,
  };

  return {
    user: {
      name: providerProfile.name,
      email: profile.data.email,
      image: providerProfile.picture || undefined,
      emailVerified: true,
    },
    data: providerProfile,
  };
}

export async function authorizeGoogleUserInfo(
  tokens: GoogleOAuthTokens,
  audience: string,
  loadStoredAccount: (
    accountId: string,
  ) => Promise<StoredGoogleAccountAccess | null>,
  persistScopes: (id: string, scopes: readonly string[]) => Promise<void>,
  verifyIdToken: GoogleIdTokenVerifier = verifyGoogleIdToken,
) {
  const result = await getGoogleUserInfo(tokens, audience, verifyIdToken);
  if (!result) return null;

  const stored = await loadStoredAccount(result.data.sub);
  if (!tokens.refreshToken && !stored?.hasRefreshToken) return null;
  if (!stored) return result;

  const scopes = [...new Set(tokens.scopes ?? [])];
  const storedScopes = new Set(stored.scopes);
  if (
    scopes.length !== storedScopes.size ||
    scopes.some((scope) => !storedScopes.has(scope))
  ) {
    await persistScopes(stored.id, scopes);
  }
  return result;
}

export function isGoogleIdTokenOnlyRequest(path: string, body: unknown) {
  if (path !== "/sign-in/social" && path !== "/link-social") return false;
  return z
    .object({ provider: z.literal("google"), idToken: z.unknown() })
    .safeParse(body).success;
}
