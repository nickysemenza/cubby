import { oauthProvider } from "@better-auth/oauth-provider";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { jwt } from "better-auth/plugins";
import { describe, expect, it } from "vitest";
import { z } from "zod";

const baseURL = "http://localhost:3000";
const resource = "https://cubby.example/api/mcp";
const callback = "https://cubby.example/api/import/agent/oauth/callback";
const clientId = "cubby-purchase-agent";
type OAuthRequestBody = Record<string, string | boolean>;

const consentResultSchema = z.object({
  redirect: z.boolean().optional(),
  url: z.string().optional(),
  redirect_uri: z.string().optional(),
});

function cookieHeader(headers: Headers) {
  return headers
    .getSetCookie()
    .filter((cookie) => cookie.startsWith("better-auth."))
    .map((cookie) => cookie.slice(0, cookie.indexOf(";")))
    .join("; ");
}

function createHarness() {
  const now = new Date();
  const database: Parameters<typeof memoryAdapter>[0] = {
    user: [],
    session: [],
    account: [],
    verification: [],
    jwks: [],
    oauthConsent: [],
    oauthAccessToken: [],
    oauthRefreshToken: [],
    oauthClient: [
      {
        id: clientId,
        clientId,
        clientSecret: null,
        disabled: false,
        skipConsent: false,
        enableEndSession: false,
        subjectType: "public",
        scopes: ["openid", "profile", "email", "offline_access"],
        userId: null,
        createdAt: now,
        updatedAt: now,
        name: "Cubby Purchase Agent",
        uri: "https://cubby.example",
        redirectUris: [callback],
        tokenEndpointAuthMethod: "none",
        grantTypes: ["authorization_code", "refresh_token"],
        responseTypes: ["code"],
        requirePKCE: true,
      },
    ],
    oauthResource: [
      {
        id: "cubby-mcp",
        identifier: resource,
        name: "Cubby MCP",
        createdAt: now,
        updatedAt: now,
      },
    ],
    oauthClientResource: [
      {
        id: `${clientId}:cubby-mcp`,
        clientId,
        resourceId: resource,
        createdAt: now,
      },
    ],
  };
  return betterAuth({
    baseURL,
    secret: "test-secret-that-is-long-enough-for-better-auth",
    database: memoryAdapter(database),
    emailAndPassword: { enabled: true },
    rateLimit: { enabled: false },
    plugins: [
      jwt({ jwt: { issuer: baseURL } }),
      oauthProvider({
        loginPage: "/auth/sign-in",
        consentPage: "/oauth/consent",
        scopes: ["openid", "profile", "email", "offline_access"],
        resources: [{ identifier: resource, name: "Cubby MCP" }],
        enforcePerClientResources: true,
      }),
    ],
  });
}

async function post(
  auth: ReturnType<typeof createHarness>,
  path: string,
  body: OAuthRequestBody,
  cookie?: string,
) {
  const headers = new Headers({ "content-type": "application/json" });
  if (cookie) headers.set("cookie", cookie);
  return auth.handler(
    new Request(`${baseURL}/api/auth${path}`, {
      method: "POST",
      redirect: "manual",
      headers,
      body: JSON.stringify(body),
    }),
  );
}

describe("purchase agent OAuth provider", () => {
  it("authorizes with consent and exchanges a PKCE code for a durable refresh grant", async () => {
    const auth = createHarness();
    const email = `oauth-${crypto.randomUUID()}@example.test`;
    await post(auth, "/sign-up/email", {
      email,
      password: "safe-test-password",
      name: "OAuth Test",
    });
    const signIn = await post(auth, "/sign-in/email", {
      email,
      password: "safe-test-password",
    });
    const cookie = cookieHeader(signIn.headers);

    const verifier = "v".repeat(48);
    const challengeBytes = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(verifier),
    );
    const challenge = Buffer.from(challengeBytes).toString("base64url");
    const authorize = new URL(`${baseURL}/api/auth/oauth2/authorize`);
    authorize.searchParams.set("response_type", "code");
    authorize.searchParams.set("client_id", clientId);
    authorize.searchParams.set("redirect_uri", callback);
    authorize.searchParams.set("scope", "openid profile email offline_access");
    authorize.searchParams.set("state", "state-1");
    authorize.searchParams.set("code_challenge", challenge);
    authorize.searchParams.set("code_challenge_method", "S256");
    authorize.searchParams.set("resource", resource);

    const authorizationResponse = await auth.handler(
      new Request(authorize, {
        redirect: "manual",
        headers: { cookie, accept: "text/html" },
      }),
    );
    const consentLocation = authorizationResponse.headers.get("location");
    if (!consentLocation) {
      throw new Error(
        `Authorization did not redirect (${authorizationResponse.status}): ${await authorizationResponse.text()}`,
      );
    }
    const consentURL = new URL(consentLocation, baseURL);
    expect(consentURL.pathname).toBe("/oauth/consent");

    const consentResponse = await post(
      auth,
      "/oauth2/consent",
      { accept: true, oauth_query: consentURL.search.slice(1) },
      cookie,
    );
    const consentResult = consentResultSchema.parse(
      await consentResponse.json(),
    );
    const callbackLocation =
      consentResponse.headers.get("location") ??
      consentResult.url ??
      consentResult.redirect_uri;
    if (!callbackLocation)
      throw new Error("Consent response did not include a callback URL");
    const callbackURL = new URL(callbackLocation, baseURL);
    expect(callbackURL.origin + callbackURL.pathname).toBe(callback);
    expect(callbackURL.searchParams.get("state")).toBe("state-1");
    const code = callbackURL.searchParams.get("code");
    if (!code) throw new Error("Authorization callback did not include a code");

    const tokenResponse = await auth.handler(
      new Request(`${baseURL}/api/auth/oauth2/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: clientId,
          code,
          code_verifier: verifier,
          redirect_uri: callback,
          resource,
        }),
      }),
    );
    expect(tokenResponse.status).toBe(200);
    await expect(tokenResponse.json()).resolves.toMatchObject({
      access_token: expect.any(String),
      refresh_token: expect.any(String),
      token_type: "Bearer",
    });
  });
});
