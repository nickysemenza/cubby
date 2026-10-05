import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { describe, expect, it, vi } from "vitest";

import {
  ChatGptSession,
  type ChatGptConnection,
  type CredentialStore,
} from "./session";

// Failure modes: concurrent token rotation, losing the replacement on restart,
// absent permission, stale model selection, and accidentally returning tokens.
describe("ChatGPT credential ownership", () => {
  // A temporary catalog failure must not orphan a newly authorized renewable session.
  it("retains a verified first registration when the catalog probe fails", async () => {
    const { publicKey, privateKey } = await generateKeyPair("RS256");
    const key = {
      ...(await exportJWK(publicKey)),
      kid: "example-sign-in",
      alg: "RS256",
    };
    const idToken = await new SignJWT({
      nonce: "example-nonce-value",
      email: "user@example.com",
    })
      .setProtectedHeader({ alg: "RS256", kid: key.kid })
      .setIssuer("https://auth.openai.com")
      .setAudience("oaiapp_example")
      .setSubject("example-subject")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);
    vi.stubGlobal("fetch", async () => Response.json({ keys: [key] }));
    const records = new Map<string, ChatGptConnection | string>();
    const store: CredentialStore = {
      get: async (key) => records.get(key),
      put: async (key, value) => {
        records.set(key, value);
      },
      delete: async (key) => records.delete(key),
    };
    let catalogFails = true;
    const session = new ChatGptSession(store, async (url) => {
      if (String(url).includes("oauth/token"))
        return Response.json({
          access_token: "example-access",
          refresh_token: "example-refresh",
          expires_in: 3600,
          token_type: "Bearer",
          scope: "chatgpt.tokens.use.direct resource.invoke",
          id_token: idToken,
        });
      return catalogFails
        ? new Response("example temporary catalog failure", { status: 503 })
        : Response.json({ models: [] });
    });
    try {
      await expect(
        session.connect({
          code: "example-code",
          clientId: "oaiapp_example",
          verifier: "v".repeat(43),
          nonce: "example-nonce-value",
          redirectUri: "http://127.0.0.1:12345/auth/callback",
        }),
      ).rejects.toThrow("temporary catalog failure");
      expect(records.get("connection")).toMatchObject({
        clientId: "oaiapp_example",
        subject: "example-subject",
        accessToken: "example-access",
        refreshToken: "example-refresh",
      });
      const restarted = new ChatGptSession(store, async () =>
        Response.json({ models: [] }),
      );
      expect(await restarted.authorizationHost()).toMatchObject({
        clientId: "oaiapp_example",
      });
      catalogFails = false;
      expect(await session.models()).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("refreshes once for concurrent requests and persists the rotated session", async () => {
    const records = new Map<string, ChatGptConnection | string>();
    const store: CredentialStore = {
      get: async (key) => records.get(key),
      put: async (key, value) => {
        records.set(key, value);
      },
      delete: async (key) => records.delete(key),
    };
    records.set("connection", {
      connected: true,
      clientId: "oaiapp_example",
      subject: "example-subject",
      email: "user@example.com",
      accessToken: "expired-example",
      refreshToken: "refresh-example",
      expiresAt: 0,
    });
    const refreshed = Promise.withResolvers<Response>();
    const upstream = vi.fn<typeof fetch>((input) => {
      if (String(input).includes("oauth/token")) return refreshed.promise;
      return Promise.resolve(
        Response.json({
          models: [
            {
              slug: "plan-example",
              display_name: "Example",
              visibility: "list",
            },
          ],
        }),
      );
    });
    const session = new ChatGptSession(store, upstream);
    const first = session.models();
    const second = session.models();
    await vi.waitFor(() => expect(upstream).toHaveBeenCalledTimes(1));
    refreshed.resolve(
      Response.json({
        access_token: "access-next",
        refresh_token: "refresh-next",
        expires_in: 3600,
        token_type: "Bearer",
        scope: "chatgpt.tokens.use.direct resource.invoke",
      }),
    );
    await Promise.all([first, second]);
    expect(
      upstream.mock.calls.filter(([url]) =>
        String(url).includes("oauth/token"),
      ),
    ).toHaveLength(1);
    expect(records.get("connection")).toMatchObject({
      accessToken: "access-next",
      refreshToken: "refresh-next",
    });
    expect(await session.status()).toMatchObject({
      connected: true,
      email: "user@example.com",
    });
    const restarted = new ChatGptSession(store, upstream);
    await restarted.models();
    expect(
      upstream.mock.calls.filter(([url]) =>
        String(url).includes("oauth/token"),
      ),
    ).toHaveLength(1);
  });

  it("keeps credentials on a temporary refresh failure and never issues inference", async () => {
    const record = {
      connected: true,
      clientId: "oaiapp_example",
      subject: "example-subject",
      email: null,
      accessToken: "expired",
      refreshToken: "saved",
      expiresAt: 0,
    };
    const put = vi.fn();
    const session = new ChatGptSession(
      { get: async () => record, put, delete: vi.fn() },
      async () =>
        new Response('{"error":"temporarily_unavailable"}', { status: 503 }),
    );
    await expect(session.infer({ input: [] }, "gpt-6-luna")).rejects.toThrow(
      "temporarily_unavailable",
    );
    expect(put).not.toHaveBeenCalled();
  });
  it("clears terminally unusable tokens and retains registration for reauthorization", async () => {
    let saved: ChatGptConnection | string | undefined = {
      connected: true,
      clientId: "oaiapp_example",
      subject: "example-subject",
      email: "user@example.com",
      accessToken: "expired",
      refreshToken: "saved",
      expiresAt: 0,
    };
    const session = new ChatGptSession(
      {
        get: async () => saved,
        put: async (_key, value) => {
          saved = value;
        },
        delete: async () => false,
      },
      async () => new Response('{"error":"invalid_grant"}', { status: 400 }),
    );
    await expect(session.infer({ input: [] }, "gpt-6-luna")).rejects.toThrow(
      "invalid_grant",
    );
    expect(saved).toMatchObject({
      connected: true,
      clientId: "oaiapp_example",
      subject: "example-subject",
      accessToken: null,
      refreshToken: null,
    });
    expect(await session.status()).toMatchObject({
      connected: true,
      needsReauthorization: true,
    });
    await expect(session.infer({ input: [] }, "gpt-6-luna")).rejects.toThrow(
      "Reconnect",
    );
  });
  it("revokes tokens while keeping the issued client registration", async () => {
    let saved: ChatGptConnection | string | undefined = {
      connected: true,
      clientId: "oaiapp_example",
      subject: "example-subject",
      email: null,
      accessToken: "access",
      refreshToken: "refresh",
      expiresAt: 0,
    };
    const session = new ChatGptSession(
      {
        get: async (key) => (key === "connection" ? saved : "urn:uuid:example"),
        put: async (_key, value) => {
          saved = value;
        },
        delete: async () => {
          saved = undefined;
          return true;
        },
      },
      async (input) =>
        String(input).includes("openid-configuration")
          ? Response.json({
              revocation_endpoint: "https://auth.openai.com/revoke",
            })
          : new Response(null, { status: 200 }),
    );
    await session.disconnect();
    expect(await session.authorizationHost()).toMatchObject({
      clientId: "oaiapp_example",
    });
    expect(await session.status()).toMatchObject({ connected: false });
    expect(saved).toMatchObject({ accessToken: null, refreshToken: null });
  });
});
