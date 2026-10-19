import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ChatGptSession,
  type ChatGptConnection,
  type CredentialStore,
} from "./session";

const credential = (): ChatGptConnection => ({
  connected: true,
  clientId: "oaiapp_example",
  subject: "example-subject",
  email: "user@example.com",
  accessToken: "example-access",
  refreshToken: "example-refresh",
  expiresAt: 0,
});
function harness(upstream: typeof fetch, initial = credential()) {
  const records = new Map<string, ChatGptConnection | string>([
    ["connection", initial],
    ["hostId", "urn:uuid:example"],
  ]);
  const store: CredentialStore = {
    get: async (key) => records.get(key),
    put: async (key, value) => {
      records.set(key, value);
    },
    delete: async (key) => records.delete(key),
  };
  return { records, session: new ChatGptSession(store, upstream), store };
}
afterEach(() => vi.useRealTimers());

// Failures: an invalid client loops on the old registration; refresh loses or
// removes permission; transient admission buys fallback early; failed revocation
// leaves local tokens usable; reconnect loses the welcome dismissal.
describe("ChatGPT connection recovery", () => {
  it("forgets an invalid client while retaining the account and host", async () => {
    const { session, records } = harness(async () =>
      Response.json({ error: "invalid_client" }, { status: 400 }),
    );
    await expect(session.models()).rejects.toThrow("invalid_client");
    expect(records.get("connection")).toMatchObject({
      clientId: null,
      subject: "example-subject",
      accessToken: null,
      refreshToken: null,
    });
    expect(await session.authorizationHost()).toEqual({
      hostId: "urn:uuid:example",
      clientId: null,
      loginHint: "user@example.com",
      permissionRecovery: false,
    });
    expect(await session.status()).toMatchObject({
      needsReauthorization: true,
      issue: expect.stringContaining("registration"),
    });
  });
  it("retains saved scopes when refresh omits them", async () => {
    const upstream = vi.fn<typeof fetch>(async (url) =>
      String(url).includes("oauth/token")
        ? Response.json({
            access_token: "next-access",
            refresh_token: "next-refresh",
            expires_in: 3600,
            token_type: "Bearer",
          })
        : Response.json({ models: [] }),
    );
    const { session, records } = harness(upstream, {
      ...credential(),
      scopes: "chatgpt.tokens.use.direct resource.invoke",
    });
    await session.models();
    expect(records.get("connection")).toMatchObject({
      scopes: "chatgpt.tokens.use.direct resource.invoke",
    });
  });
  it.each(["resource.invoke", ""])(
    "disables inference when refresh removes direct permission: %s",
    async (scope) => {
      const upstream = vi.fn<typeof fetch>(async (url) =>
        String(url).includes("oauth/token")
          ? Response.json({
              access_token: "next-access",
              refresh_token: "next-refresh",
              expires_in: 3600,
              token_type: "Bearer",
              scope,
            })
          : Response.json({ models: [] }),
      );
      const { session } = harness(upstream, {
        ...credential(),
        scopes: "chatgpt.tokens.use.direct resource.invoke",
      });
      await expect(session.models()).rejects.toThrow("permission");
      expect(await session.status()).toMatchObject({
        needsReauthorization: true,
      });
      await expect(session.models()).rejects.toThrow("permission");
      expect(upstream).toHaveBeenCalledTimes(1);
      expect(await session.authorizationHost()).toMatchObject({
        permissionRecovery: true,
      });
    },
  );
  it.each([
    "subscription_sharing_user_not_eligible",
    "subscription_sharing_invalid_user",
  ])("stops plan requests after %s", async (code) => {
    const upstream = vi.fn<typeof fetch>(async () =>
      Response.json(
        { error: { code } },
        { status: code.endsWith("not_eligible") ? 403 : 401 },
      ),
    );
    const { session } = harness(upstream, {
      ...credential(),
      expiresAt: Date.now() + 3600_000,
    });
    const response = await session.infer({ input: [] }, "gpt-6-sol");
    expect(response.ok).toBe(false);
    expect(await session.status()).toMatchObject({
      needsReauthorization: true,
      issue: expect.stringContaining(code),
    });
    await expect(session.infer({ input: [] }, "gpt-6-sol")).rejects.toThrow(
      code,
    );
    expect(upstream).toHaveBeenCalledTimes(1);
  });
  it("disables plan use when the model catalog rejects the subscriber", async () => {
    const upstream = vi.fn<typeof fetch>(async () =>
      Response.json(
        { error: { code: "subscription_sharing_invalid_user" } },
        { status: 401 },
      ),
    );
    const { session } = harness(upstream, {
      ...credential(),
      expiresAt: Date.now() + 3600_000,
    });
    await expect(session.models()).rejects.toThrow(
      "subscription_sharing_invalid_user",
    );
    expect(await session.status()).toMatchObject({
      needsReauthorization: true,
    });
    await expect(session.infer({ input: [] }, "gpt-6-sol")).rejects.toThrow(
      "subscription_sharing_invalid_user",
    );
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it("retries pre-stream 503s with the same body and stops immediately on abort", async () => {
    vi.useFakeTimers();
    const upstream = vi.fn<typeof fetch>(
      async () => new Response("example unavailable", { status: 503 }),
    );
    const { session } = harness(upstream, {
      ...credential(),
      expiresAt: Date.now() + 3600_000,
    });
    const pending = session.infer({ input: [] }, "gpt-6-sol");
    await vi.advanceTimersByTimeAsync(0);
    expect(upstream).toHaveBeenCalledTimes(1);
    for (const [delay, calls] of [
      [2000, 2],
      [8000, 3],
      [30000, 4],
    ] satisfies [number, number][]) {
      await vi.advanceTimersByTimeAsync(delay);
      expect(upstream).toHaveBeenCalledTimes(calls);
    }
    expect((await pending).status).toBe(503);
    expect(
      new Set(upstream.mock.calls.map(([, init]) => init?.body)).size,
    ).toBe(1);
    const abort = new AbortController();
    const aborted = session
      .infer({ input: [] }, "gpt-6-sol", abort.signal)
      .catch((error) => error);
    await vi.advanceTimersByTimeAsync(0);
    abort.abort(new Error("example cancelled"));
    expect(await aborted).toMatchObject({ message: "example cancelled" });
    await vi.advanceTimersByTimeAsync(40000);
    expect(upstream).toHaveBeenCalledTimes(5);
  });
  it.each([503, "network", 400])(
    "clears local tokens even when revocation is unconfirmed: %s",
    async (failure) => {
      vi.useFakeTimers();
      const revoke = vi.fn(async () => {
        if (failure === "network") throw new Error("example network failure");
        return new Response("example refusal", { status: Number(failure) });
      });
      const { session, records } = harness(async (url) =>
        String(url).includes("openid-configuration")
          ? Response.json({
              revocation_endpoint: "https://auth.openai.com/revoke",
            })
          : revoke(),
      );
      const pending = session.disconnect();
      await vi.advanceTimersByTimeAsync(40000);
      await pending;
      expect(revoke).toHaveBeenCalledTimes(failure === 400 ? 1 : 4);
      expect(records.get("connection")).toMatchObject({
        connected: false,
        clientId: "oaiapp_example",
        accessToken: null,
        refreshToken: null,
      });
      expect(await session.status()).toMatchObject({
        connected: false,
        issue: expect.stringContaining("couldn't confirm"),
      });
      expect((await session.status()).issue).toContain(
        failure === "network"
          ? "example network failure"
          : `OpenAI revocation HTTP ${failure}: example refusal`,
      );
      expect((await session.authorizationHost()).hostId).toBe(
        "urn:uuid:example",
      );
    },
  );
  it("persists welcome dismissal across a restarted session", async () => {
    const { session, store } = harness(async () =>
      Response.json({ models: [] }),
    );
    expect(await session.status()).toMatchObject({ welcomeDismissed: false });
    await session.dismissWelcome();
    expect(await new ChatGptSession(store).status()).toMatchObject({
      welcomeDismissed: true,
    });
  });
});

// Failures: code exchange can retain a rejected client; deterministic discovery
// errors can wait through all retries; a 503 wait can erase the last HTTP body.
it("clears the issued registration when code exchange rejects invalid_client", async () => {
  const { session, records } = harness(async () =>
    Response.json({ error: "invalid_client" }, { status: 400 }),
  );
  await expect(
    session.connect({
      code: "example-code",
      clientId: "oaiapp_example",
      verifier: "v".repeat(43),
      nonce: "example-nonce-value",
      redirectUri: "http://127.0.0.1:12345/auth/callback",
    }),
  ).rejects.toThrow(
    "OpenAI no longer accepts Cubby’s registration — connect again.",
  );
  expect(await session.authorizationHost()).toMatchObject({
    hostId: "urn:uuid:example",
    clientId: null,
    permissionRecovery: false,
  });
  expect(records.get("connection")).toMatchObject({
    subject: "example-subject",
    accessToken: null,
    refreshToken: null,
  });
});
it.each(["parse", "origin"])(
  "does not retry deterministic discovery failures: %s",
  async (failure) => {
    vi.useFakeTimers();
    const upstream = vi.fn<typeof fetch>(async () =>
      failure === "parse"
        ? Response.json({})
        : Response.json({
            revocation_endpoint: "https://untrusted.example.com/revoke",
          }),
    );
    const { session } = harness(upstream);
    const pending = session.disconnect();
    await vi.advanceTimersByTimeAsync(40000);
    await pending;
    expect(upstream).toHaveBeenCalledTimes(1);
    const status = await session.status();
    expect(status.issue).toContain(
      failure === "parse"
        ? "revocation_endpoint"
        : "Unexpected OpenAI revocation endpoint",
    );
    await session.dismissWelcome();
    expect(await session.status()).toMatchObject({
      issue: null,
      connected: false,
    });
  },
);
it("returns the last 503 body when the next wait cannot fit the deadline", async () => {
  vi.useFakeTimers();
  const upstream = vi.fn<typeof fetch>(
    async () => new Response("example unavailable", { status: 503 }),
  );
  const { session } = harness(upstream, {
    ...credential(),
    expiresAt: Date.now() + 3600_000,
  });
  const pending = session.infer(
    { input: [] },
    "gpt-6-sol",
    undefined,
    Date.now() + 5000,
  );
  await vi.advanceTimersByTimeAsync(2000);
  const response = await pending;
  expect(response.status).toBe(503);
  expect(await response.text()).toBe("example unavailable");
  expect(upstream).toHaveBeenCalledTimes(2);
});

// Removing cache breakpoints must not buy another complete outage retry budget.
it("shares the 503 retry budget with the breakpoint-stripped request", async () => {
  vi.useFakeTimers();
  let calls = 0;
  const upstream = vi.fn<typeof fetch>(async () => {
    calls += 1;
    return calls === 2
      ? Response.json(
          {
            error: {
              type: "invalid_request_error",
              param: "input",
              message: "example breakpoint refusal",
            },
          },
          { status: 400 },
        )
      : new Response("example unavailable", { status: 503 });
  });
  const { session } = harness(upstream, {
    ...credential(),
    expiresAt: Date.now() + 3600_000,
  });
  const pending = session.infer(
    {
      input: [
        {
          type: "function_call_output",
          call_id: "example-call",
          output: "Example",
        },
      ],
    },
    "gpt-6-sol",
  );
  await vi.advanceTimersByTimeAsync(40000);
  const response = await pending;
  expect(response.status).toBe(503);
  expect(await response.text()).toBe("example unavailable");
  expect(upstream).toHaveBeenCalledTimes(5);
});
