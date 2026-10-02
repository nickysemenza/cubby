import type { BetterAuthPlugin } from "better-auth";
import { z } from "zod";

import type { authorizeGoogleUserInfo } from "./google-auth";

type VerifyIdToken = NonNullable<Parameters<typeof authorizeGoogleUserInfo>[4]>;
type Authorize = (
  tokens: Parameters<typeof authorizeGoogleUserInfo>[0],
  verifier: VerifyIdToken,
) => ReturnType<typeof authorizeGoogleUserInfo>;

export function localGoogleProviderOrigin(mode: string, origin?: string) {
  if (mode !== "true" || !origin) return undefined;
  const url = new URL(origin);
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error("E2E Google provider must be a loopback HTTP origin");
  return url.origin;
}
const tokenResponse = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  id_token: z.string().min(1),
  expires_in: z.number().positive(),
  scope: z.string().min(1),
});
const jwks = z.object({
  keys: z.array(
    z.object({
      kty: z.literal("RSA"),
      n: z.string(),
      e: z.string(),
      kid: z.string(),
      alg: z.literal("RS256"),
    }),
  ),
});
const claimsSchema = z
  .object({
    iss: z.string(),
    aud: z.string(),
    sub: z.string(),
    email: z.email(),
    email_verified: z.literal(true),
    iat: z.number(),
    exp: z.number(),
  })
  .loose();
const bytes = (value: string) =>
  Uint8Array.from(
    atob(value.replaceAll("-", "+").replaceAll("_", "/")),
    (character) => character.charCodeAt(0),
  );

/** Only the provider transport changes: Better Auth still validates callback state/PKCE and persists the account. */
export function localGoogleProviderPlugin(
  origin: string,
  authorize: Authorize,
): BetterAuthPlugin {
  const verify: VerifyIdToken = async ({ token, audience }) => {
    const [headerPart, payload, signature, extra] = token.split(".");
    if (!headerPart || !payload || !signature || extra) return null;
    const header = z
      .object({ alg: z.literal("RS256"), kid: z.string() })
      .parse(JSON.parse(new TextDecoder().decode(bytes(headerPart))));
    const response = await fetch(`${origin}/jwks`);
    if (!response.ok)
      throw new Error(`Local provider JWKS: HTTP ${response.status}`);
    const key = jwks
      .parse(await response.json())
      .keys.find((candidate) => candidate.kid === header.kid);
    if (!key) return null;
    const imported = await crypto.subtle.importKey(
      "jwk",
      key,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    if (
      !(await crypto.subtle.verify(
        "RSASSA-PKCS1-v1_5",
        imported,
        bytes(signature),
        new TextEncoder().encode(`${headerPart}.${payload}`),
      ))
    )
      return null;
    const claims = claimsSchema.parse(
      JSON.parse(new TextDecoder().decode(bytes(payload))),
    );
    const now = Date.now() / 1000;
    if (
      claims.iss !== origin ||
      !(Array.isArray(audience)
        ? audience.includes(claims.aud)
        : claims.aud === audience) ||
      claims.exp <= now ||
      claims.iat > now + 10 ||
      claims.iat < now - 3600
    )
      return null;
    return claims;
  };
  return {
    id: "cubby-local-google-provider",
    init(context) {
      const provider = context.socialProviders.find(
        (candidate) => candidate.id === "google",
      );
      if (!provider)
        throw new Error(
          "Local Google provider requires synthetic OAuth credentials",
        );
      const createURL = provider.createAuthorizationURL.bind(provider);
      provider.createAuthorizationURL = async (input) => {
        const original = await createURL(input);
        const url = new URL("/authorize", origin);
        url.search = original.search;
        return url;
      };
      provider.validateAuthorizationCode = async ({
        code,
        codeVerifier,
        redirectURI,
      }) => {
        const response = await fetch(`${origin}/token`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            code,
            code_verifier: codeVerifier ?? "",
            redirect_uri: redirectURI,
          }),
        });
        if (!response.ok)
          throw new Error(
            `Local provider token exchange: HTTP ${response.status}`,
          );
        const tokens = tokenResponse.parse(await response.json());
        return {
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token,
          idToken: tokens.id_token,
          accessTokenExpiresAt: new Date(Date.now() + tokens.expires_in * 1000),
          scopes: tokens.scope.split(" "),
        };
      };
      provider.getUserInfo = (tokens) => authorize(tokens, verify);
    },
  };
}
