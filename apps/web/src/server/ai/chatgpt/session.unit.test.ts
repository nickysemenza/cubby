import type { GatewayQuery } from "@cubby/shared/ai/gateway-request";
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
  // Budgeted callers replay a plan refusal on paid inference; the refusal
  // body must stay readable in Workers logs and reach the caller unchanged.
  it("logs a refused inference and returns its body to the caller", async () => {
    const refusal = JSON.stringify({
      error: {
        type: "invalid_request_error",
        param: "input",
        code: "subscription_sharing_unsupported_capability",
        message: "Synthetic refusal for Bearer sk-example-secret-value",
      },
    });
    const record = {
      connected: true,
      clientId: "oaiapp_example",
      subject: "example-subject",
      email: null,
      accessToken: "access-example",
      refreshToken: "refresh-example",
      expiresAt: Date.now() + 3_600_000,
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const session = new ChatGptSession(
        { get: async () => record, put: vi.fn(), delete: vi.fn() },
        async () => new Response(refusal, { status: 400 }),
      );
      const response = await session.infer({ input: [] }, "gpt-6-sol");
      expect(response.status).toBe(400);
      expect(await response.text()).toBe(refusal);
      const logged = JSON.stringify(warn.mock.calls);
      expect(logged).toContain("subscription_sharing_unsupported_capability");
      expect(logged).not.toContain("sk-example-secret-value");
    } finally {
      warn.mockRestore();
    }
  });

  // Explicit cache breakpoints were never verified live. Failure modes: a
  // refused breakpoint fails every plan call; a quota refusal retried as a
  // breakpoint error doubles the refused calls; a request without tool
  // results is resent unchanged.
  describe("cache breakpoint guard", () => {
    const record = {
      connected: true,
      clientId: "oaiapp_example",
      subject: "example-subject",
      email: null,
      accessToken: "access-example",
      refreshToken: "refresh-example",
      expiresAt: Date.now() + 3_600_000,
    };
    const body: GatewayQuery = {
      input: [
        { role: "system", content: "Frame" },
        { role: "user", content: "Synthetic Email" },
        {
          type: "function_call",
          call_id: "c1",
          name: "claim",
          arguments: "{}",
        },
        { type: "function_call_output", call_id: "c1", output: "Synthetic" },
      ],
      tools: [{ type: "function", name: "claim" }],
    };
    const refusal = (error: Record<string, string>, status = 400) =>
      new Response(JSON.stringify({ error }), { status });
    const harness = (answers: Response[]) => {
      const sent: Array<Array<{ type?: string; output?: unknown }>> = [];
      const session = new ChatGptSession(
        { get: async () => record, put: vi.fn(), delete: vi.fn() },
        async (_url, init) => {
          sent.push(JSON.parse(String(init?.body)).input);
          return answers.shift() ?? new Response("{}", { status: 200 });
        },
      );
      const marked = (index: number) =>
        JSON.stringify(sent[index]).includes("prompt_cache_breakpoint");
      return { session, sent, marked };
    };

    it("retries a refused breakpoint once without breakpoints and keeps that", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const { session, sent, marked } = harness([
          refusal({
            type: "invalid_request_error",
            param: "input[3].output[0].prompt_cache_breakpoint",
            code: "subscription_sharing_unsupported_capability",
            message: "Synthetic: prompt_cache_breakpoint is not supported",
          }),
        ]);
        const response = await session.infer(body, "gpt-6-sol");
        expect(response.status).toBe(200);
        expect([marked(0), marked(1)]).toEqual([true, false]);
        expect(JSON.stringify(warn.mock.calls)).toContain(
          "prompt_cache_breakpoint is not supported",
        );
        await session.infer(body, "gpt-6-sol");
        expect(sent).toHaveLength(3);
        expect(marked(2)).toBe(false);
      } finally {
        warn.mockRestore();
      }
    });

    it.each([
      [
        "quota",
        refusal(
          {
            type: "invalid_request_error",
            param: "input",
            code: "subscription_sharing_usage_limit_exceeded",
            message: "Synthetic usage limit",
          },
          400,
        ),
      ],
      [
        "rate limit",
        refusal({ type: "rate_limit_error", code: "rate_limit_exceeded" }, 429),
      ],
      [
        "unrelated field",
        refusal({
          type: "invalid_request_error",
          param: "reasoning.effort",
          code: "invalid_value",
          message: "Synthetic unsupported effort",
        }),
      ],
    ])("returns a %s refusal without a breakpoint retry", async (_, answer) => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const { session, sent } = harness([answer]);
        const response = await session.infer(body, "gpt-6-sol");
        expect(response.ok).toBe(false);
        expect(sent).toHaveLength(1);
      } finally {
        warn.mockRestore();
      }
    });
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
