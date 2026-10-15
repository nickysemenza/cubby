import { z } from "zod";

import { createGmailApiClient, type GmailFetcher } from "./client";
import type { GmailProvider } from "./types";

const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const DEFAULT_REFRESH_SKEW_MS = 60_000;

export type GmailAccountTokenRecord = {
  userId: string;
  providerId: string;
  accessToken: string | null;
  refreshToken: string | null;
  accessTokenExpiresAt: Date | null;
};

export type GmailAccountTokenPatch = {
  accessToken: string;
  accessTokenExpiresAt: Date;
  refreshToken?: string;
};

export interface GmailAccountTokenStore {
  findGoogleAccount(userId: string): Promise<GmailAccountTokenRecord | null>;
  updateGoogleAccount(
    userId: string,
    patch: GmailAccountTokenPatch,
  ): Promise<void>;
}

export type GmailAccessToken = {
  accessToken: string;
  accessTokenExpiresAt: Date | null;
};

export class GmailAuthorizationError extends Error {
  readonly code = "gmail_authorization_required";

  constructor(message: string) {
    super(message);
    this.name = "GmailAuthorizationError";
  }
}

export type GmailTokenResolverOptions = {
  store: GmailAccountTokenStore;
  clientId: string;
  clientSecret: string;
  tokenEndpoint?: string;
  fetcher?: GmailFetcher;
  now?: () => Date;
  refreshSkewMs?: number;
};

const googleRefreshResponse = z.object({
  access_token: z.string().optional(),
  expires_in: z.number().finite().optional(),
  refresh_token: z.string().optional(),
  error: z.string().optional(),
  error_description: z.string().optional(),
});
type GoogleRefreshResponse = z.infer<typeof googleRefreshResponse>;

const isUsableToken = (value: unknown): value is string =>
  z.string().min(1).safeParse(value).success;

const isFresh = (
  account: GmailAccountTokenRecord,
  now: Date,
  refreshSkewMs: number,
): account is GmailAccountTokenRecord & {
  accessToken: string;
  accessTokenExpiresAt: Date;
} =>
  isUsableToken(account.accessToken) &&
  account.accessTokenExpiresAt !== null &&
  account.accessTokenExpiresAt.getTime() > now.getTime() + refreshSkewMs;

const parseRefreshResponse = async (
  response: Response,
): Promise<GoogleRefreshResponse> => {
  let body: GoogleRefreshResponse = {};
  try {
    body = googleRefreshResponse.parse(await response.json());
  } catch {
    // SILENT: an unparseable body leaves `body` at its `{}` default; the
    // `!response.ok` branch below already falls back to `HTTP ${status}`
    // when none of `body`'s fields are usable.
  }
  if (!response.ok) {
    const detail = isUsableToken(body.error_description)
      ? body.error_description
      : isUsableToken(body.error)
        ? body.error
        : `HTTP ${response.status}`;
    throw new GmailAuthorizationError(`Gmail token refresh failed: ${detail}`);
  }
  return body;
};

export const createGmailAccessTokenResolver = (
  options: GmailTokenResolverOptions,
): ((userId: string) => Promise<GmailAccessToken>) => {
  const fetcher = options.fetcher ?? fetch;
  const now = options.now ?? (() => new Date());
  const refreshSkewMs = options.refreshSkewMs ?? DEFAULT_REFRESH_SKEW_MS;
  const tokenEndpoint = options.tokenEndpoint ?? GOOGLE_TOKEN_ENDPOINT;

  return async (userId) => {
    const account = await options.store.findGoogleAccount(userId);
    if (!account || account.providerId !== "google") {
      throw new GmailAuthorizationError("No Google account is connected");
    }

    const current = now();
    if (isFresh(account, current, refreshSkewMs)) {
      return {
        accessToken: account.accessToken,
        accessTokenExpiresAt: account.accessTokenExpiresAt,
      };
    }

    if (!isUsableToken(account.refreshToken)) {
      throw new GmailAuthorizationError(
        "The connected Google account has no refresh token; reconnect Gmail",
      );
    }

    const response = await fetcher(tokenEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: options.clientId,
        client_secret: options.clientSecret,
        grant_type: "refresh_token",
        refresh_token: account.refreshToken,
      }).toString(),
    });
    const body = await parseRefreshResponse(response);
    if (!isUsableToken(body.access_token)) {
      throw new GmailAuthorizationError(
        "Gmail token refresh returned no access token",
      );
    }
    const expiresIn = Math.max(0, body.expires_in ?? 3600);
    const accessTokenExpiresAt = new Date(current.getTime() + expiresIn * 1000);
    const patch: GmailAccountTokenPatch = {
      accessToken: body.access_token,
      accessTokenExpiresAt,
    };
    if (isUsableToken(body.refresh_token)) {
      patch.refreshToken = body.refresh_token;
    }
    await options.store.updateGoogleAccount(userId, patch);
    return { accessToken: body.access_token, accessTokenExpiresAt };
  };
};

export type GmailProviderFactoryOptions = GmailTokenResolverOptions & {
  gmailBaseUrl?: string;
};

export const createGmailProviderFactory = (
  options: GmailProviderFactoryOptions,
): ((userId: string) => Promise<GmailProvider>) => {
  const resolveAccessToken = createGmailAccessTokenResolver(options);
  return async (userId) =>
    createGmailApiClient({
      accessToken: (await resolveAccessToken(userId)).accessToken,
      baseUrl: options.gmailBaseUrl,
      fetcher: options.fetcher,
    });
};
