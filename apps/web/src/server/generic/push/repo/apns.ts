import { apnsEnvironment } from "@cubby/schemas/photo-import-run";
import { z } from "zod";

import { scrubErrorMessage } from "~/lib/error-diagnostics";
import { getApnsCredentials } from "~/server/cf-env";
export type ApnsCredentials = NonNullable<
  ReturnType<typeof getApnsCredentials>
>;
export type ApnsEnvironment = z.infer<typeof apnsEnvironment>;
export type ApnsOutcome = { status: number; reason: string | null };
type JwtPart = { alg: "ES256"; kid: string } | { iss: string; iat: number };
const apnsErrorBody = z.object({ reason: z.string() });
const apnsReason = (text: string): string | null => {
  try {
    return apnsErrorBody.safeParse(JSON.parse(text)).data?.reason ?? null;
  } catch {
    return null;
  }
};
export const DEAD_TOKEN_REASONS = new Set([
  "BadDeviceToken",
  "Unregistered",
  "ExpiredToken",
]);
/** One APNs request; injectable so a test never reaches Apple. */
export type ApnsTransport = (request: {
  environment: ApnsEnvironment;
  pushToken: string;
  headers: Record<string, string>;
  body: string;
}) => Promise<ApnsOutcome>;

/**
 * Run `work`, and on failure scrub every known push token from the whole
 * error chain (message, stack, Drizzle `params`, `cause`) before it
 * propagates or is logged. SQL text and other diagnostics are kept verbatim;
 * the shared credential scrub does not recognise a bare hex token.
 */
export async function withTokensScrubbed<T>(
  tokens: readonly string[],
  work: () => Promise<T>,
): Promise<T> {
  try {
    return await work();
  } catch (error) {
    scrubTokens(error, tokens, new Set());
    throw error;
  }
}

function scrubTokens(
  value: unknown,
  tokens: readonly string[],
  seen: Set<unknown>,
) {
  if (!(value instanceof Error) || seen.has(value)) return;
  seen.add(value);
  const clean = (text: string) =>
    tokens.reduce((out, token) => out.replaceAll(token, "[push-token]"), text);
  value.message = clean(value.message);
  if (value.stack) value.stack = clean(value.stack);
  if ("params" in value && Array.isArray(value.params))
    value.params = value.params.map((param: unknown) =>
      typeof param === "string" ? clean(param) : param,
    );
  scrubTokens(value.cause, tokens, seen);
}

/** A push token is a credential; it never appears in a stored or returned error. */
export const redactPushToken = (message: string, pushToken: string) =>
  scrubErrorMessage(message.replaceAll(pushToken, "[push-token]"));

export const fetchApns: ApnsTransport = async (request) => {
  const host =
    request.environment === "production"
      ? "api.push.apple.com"
      : "api.sandbox.push.apple.com";
  const response = await fetch(
    `https://${host}/3/device/${request.pushToken}`,
    {
      method: "POST",
      headers: request.headers,
      body: request.body,
      signal: AbortSignal.timeout(10_000),
    },
  );
  if (response.ok) return { status: response.status, reason: null };
  const text = await response.text();
  return {
    status: response.status,
    reason: apnsReason(text) ?? (text.slice(0, 500) || null),
  };
};

// APNs accepts a provider token for up to an hour and rejects refreshing it
// more than once per 20 minutes, so one token is reused for 40 minutes.
let cachedJwt: { key: string; issuedAt: number; token: string } | null = null;
const JWT_REUSE_SECONDS = 40 * 60;

export async function apnsJwt(credentials: ApnsCredentials, now: number) {
  const cacheKey = `${credentials.teamId}:${credentials.keyId}`;
  if (
    cachedJwt?.key === cacheKey &&
    now - cachedJwt.issuedAt < JWT_REUSE_SECONDS
  )
    return cachedJwt.token;
  const encode = (value: JwtPart | Uint8Array) =>
    base64Url(
      value instanceof Uint8Array
        ? value
        : new TextEncoder().encode(JSON.stringify(value)),
    );
  const signingInput = `${encode({ alg: "ES256", kid: credentials.keyId })}.${encode({ iss: credentials.teamId, iat: now })}`;
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToDer(credentials.privateKey),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  // WebCrypto returns the raw r||s signature JWS ES256 expects.
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      new TextEncoder().encode(signingInput),
    ),
  );
  const token = `${signingInput}.${encode(signature)}`;
  cachedJwt = { key: cacheKey, issuedAt: now, token };
  return token;
}

const pemToDer = (pem: string) => {
  const body = pem
    .replaceAll(/-----(BEGIN|END) PRIVATE KEY-----/g, "")
    .replaceAll(/\s+/g, "");
  return Uint8Array.from(atob(body), (char) => char.charCodeAt(0));
};

const base64Url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
