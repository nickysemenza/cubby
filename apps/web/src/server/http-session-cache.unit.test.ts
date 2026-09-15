import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { bearer } from "better-auth/plugins";
import { afterEach, describe, expect, it, vi } from "vitest";

import { authenticateHttpSession } from "./http-session-cache";

const authSecret = "test-secret-that-is-long-enough-for-better-auth";

function cookieHeader(headers: Headers): string {
  return headers
    .getSetCookie()
    .filter((cookie) => cookie.startsWith("better-auth."))
    .map((cookie) => cookie.slice(0, cookie.indexOf(";")))
    .join("; ");
}

function createAuthHarness() {
  const database: Parameters<typeof memoryAdapter>[0] = {};
  const adapterFactory = memoryAdapter(database);
  const readCounters: Array<() => number> = [];
  const resetReadCounters: Array<() => void> = [];
  const auth = betterAuth({
    baseURL: "http://localhost:3000",
    secret: authSecret,
    database: (options: Parameters<typeof adapterFactory>[0]) => {
      const adapter = adapterFactory(options);
      const findOne = vi.spyOn(adapter, "findOne");
      readCounters.push(() => findOne.mock.calls.length);
      resetReadCounters.push(() => findOne.mockClear());
      return adapter;
    },
    emailAndPassword: { enabled: true },
    rateLimit: { enabled: false },
    session: {
      cookieCache: { enabled: true, maxAge: 300, refreshCache: false },
    },
    plugins: [bearer({ requireSignature: true })],
  });
  return {
    auth,
    reads: () => readCounters.reduce((total, count) => total + count(), 0),
    resetReads: () => {
      for (const reset of resetReadCounters) reset();
    },
  };
}

async function signIn(auth: ReturnType<typeof createAuthHarness>["auth"]) {
  const email = `cache-${crypto.randomUUID()}@example.test`;
  await auth.api.signUpEmail({
    body: { email, password: "safe-test-password", name: "Cache Test" },
  });
  return await auth.api.signInEmail({
    body: { email, password: "safe-test-password" },
    returnHeaders: true,
  });
}

describe("HTTP Better Auth session cache", () => {
  afterEach(() => vi.useRealTimers());

  it("uses the signed browser cookie cache without a session database lookup", async () => {
    const harness = createAuthHarness();
    const signedIn = await signIn(harness.auth);
    const headers = signedIn.headers;
    harness.resetReads();

    const session = await authenticateHttpSession({
      headers: new Headers({ cookie: cookieHeader(headers) }),
      getSession: harness.auth.api.getSession,
    });

    expect(session.response?.user.id).toBeDefined();
    expect(session.response?.session.token).toBeDefined();
    expect(harness.reads()).toBe(0);
  });

  it("uses a signed bearer session cache without inheriting browser session cookies", async () => {
    const harness = createAuthHarness();
    const signedIn = await signIn(harness.auth);
    const headers = signedIn.headers;
    const bearerToken = headers.get("set-auth-token");
    expect(bearerToken).toBeTruthy();
    harness.resetReads();

    const session = await authenticateHttpSession({
      headers: new Headers({
        authorization: `Bearer ${bearerToken}`,
        cookie: cookieHeader(headers),
      }),
      getSession: harness.auth.api.getSession,
    });

    expect(session.response?.session.token).toBe(bearerToken?.split(".", 1)[0]);
    expect(harness.reads()).toBe(0);
  });

  it("falls back to the database after the five-minute cookie cache expires", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const harness = createAuthHarness();
    const signedIn = await signIn(harness.auth);
    harness.resetReads();
    vi.setSystemTime(new Date("2026-01-01T00:05:01.000Z"));

    const session = await authenticateHttpSession({
      headers: new Headers({ cookie: cookieHeader(signedIn.headers) }),
      getSession: harness.auth.api.getSession,
    });

    expect(session.response).not.toBeNull();
    expect(harness.reads()).toBeGreaterThan(0);
  });

  it("retries authoritatively when a bearer conflicts with an ambient cached session", async () => {
    const harness = createAuthHarness();
    const first = await signIn(harness.auth);
    const second = await signIn(harness.auth);
    const bearerToken = second.headers.get("set-auth-token");
    expect(bearerToken).toBeTruthy();
    harness.resetReads();

    const session = await authenticateHttpSession({
      headers: new Headers({
        authorization: `Bearer ${bearerToken}`,
        cookie: cookieHeader(first.headers),
      }),
      getSession: harness.auth.api.getSession,
    });

    expect(session.response?.session.token).toBe(bearerToken?.split(".", 1)[0]);
    expect(session.response?.user.id).toBe(second.response.user.id);
    expect(session.response?.user.id).not.toBe(first.response.user.id);
    expect(harness.reads()).toBeGreaterThan(0);
  });

  it("issues a cache on a cold bearer read and reuses it without a database lookup", async () => {
    const harness = createAuthHarness();
    const signedIn = await signIn(harness.auth);
    const bearerToken = signedIn.headers.get("set-auth-token");
    expect(bearerToken).toBeTruthy();
    harness.resetReads();

    const cold = await authenticateHttpSession({
      headers: new Headers({ authorization: `Bearer ${bearerToken}` }),
      getSession: harness.auth.api.getSession,
    });

    expect(cold.response).not.toBeNull();
    expect(harness.reads()).toBeGreaterThan(0);
    harness.resetReads();

    const warm = await authenticateHttpSession({
      headers: new Headers({
        authorization: `Bearer ${bearerToken}`,
        cookie: cookieHeader(cold.headers),
      }),
      getSession: harness.auth.api.getSession,
    });

    expect(warm.response?.user.id).toBe(cold.response?.user.id);
    expect(harness.reads()).toBe(0);
  });

  it("rejects a tampered cookie cache and falls back to the authoritative session", async () => {
    const harness = createAuthHarness();
    const signedIn = await signIn(harness.auth);
    harness.resetReads();
    const cookies = cookieHeader(signedIn.headers).replace(
      /(better-auth\.session_data(?:\.\d+)?=)[^;]+/u,
      "$1tampered",
    );

    const session = await authenticateHttpSession({
      headers: new Headers({ cookie: cookies }),
      getSession: harness.auth.api.getSession,
    });

    expect(session.response?.user.id).toBe(signedIn.response.user.id);
    expect(harness.reads()).toBeGreaterThan(0);
  });

  it("does not fall back to an ambient session when a bearer signature is invalid", async () => {
    const harness = createAuthHarness();
    const signedIn = await signIn(harness.auth);
    harness.resetReads();

    const session = await authenticateHttpSession({
      headers: new Headers({
        authorization: "Bearer forged-token.invalid-signature",
        cookie: cookieHeader(signedIn.headers),
      }),
      getSession: harness.auth.api.getSession,
    });

    expect(session.response).toBeNull();
  });
});
