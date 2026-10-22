import { fromPartial } from "@total-typescript/shoehorn";
import { expect, it } from "vitest";

import { getAuth } from "~/lib/auth";
import { withCfEnv } from "~/server/cf-env";
import {
  createPurchaseAgentOAuthState,
  verifyPurchaseAgentOAuthState,
} from "~/server/domains/purchase-import/repo/agent-auth";

import {
  type AuthConfiguration,
  getAuthConfiguration,
  getAuthSecret,
} from "./auth-configuration";

const bindings = (configuration: Partial<AuthConfiguration>) =>
  fromPartial<Env & Partial<AuthConfiguration>>({
    BETTER_AUTH_SECRET: "synthetic-auth-secret-at-least-32-characters",
    ...configuration,
  });

it("refreshes auth policy and credentials when bindings change in a reused isolate", async () => {
  let token = "";
  const initial = await withCfEnv(
    bindings({
      ALLOW_SIGNUP: "true",
      INSECURE_AUTH_COOKIES: "true",
      E2E_AUTH_TEST_MODE: "true",
      GOOGLE_CLIENT_ID: "synthetic-client",
      GOOGLE_CLIENT_SECRET: "synthetic-provider-secret",
    }),
    async () => {
      const auth = getAuth();
      expect(getAuth()).toBe(auth);
      expect(auth.options.emailAndPassword.disableSignUp).toBe(false);
      expect(auth.options.advanced.useSecureCookies).toBe(false);
      expect(auth.options.rateLimit.enabled).toBe(false);
      expect(auth.options.socialProviders.google).toBeDefined();
      token = await createPurchaseAgentOAuthState({
        state: "synthetic-state",
        verifier: "synthetic-verifier".repeat(4),
        userId: "synthetic-user",
        secret: getAuthSecret(),
      });
      expect(
        await verifyPurchaseAgentOAuthState(token, getAuthSecret()),
      ).toMatchObject({ state: "synthetic-state" });
      return auth;
    },
  );
  await withCfEnv(
    bindings({
      BETTER_AUTH_SECRET: "synthetic-rotated-secret-at-least-32-characters",
    }),
    async () => {
      const auth = getAuth();
      expect(auth).not.toBe(initial);
      expect(auth.options.secret).toBe(getAuthSecret());
      expect(
        await verifyPurchaseAgentOAuthState(token, getAuthSecret()),
      ).toBeNull();
      expect(auth.options.emailAndPassword.disableSignUp).toBe(true);
      expect(auth.options.advanced.useSecureCookies).toBeUndefined();
      expect(auth.options.socialProviders).toEqual({});
      // Refreshing the cache cannot mutate an instance already held by a caller.
      expect(initial.options.emailAndPassword.disableSignUp).toBe(false);
      expect(initial.options.secret).not.toBe(auth.options.secret);
    },
  );
});

it("retains each invocation's configuration across overlapping async work", async () => {
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const firstSecret = "synthetic-first-secret-at-least-32-characters";
  const secondSecret = "synthetic-second-secret-at-least-32-characters";
  const first = withCfEnv(
    bindings({ BETTER_AUTH_SECRET: firstSecret, ALLOW_SIGNUP: "true" }),
    async () => {
      const auth = getAuth();
      await gate;
      expect(getAuthSecret()).toBe(firstSecret);
      expect(getAuthConfiguration().ALLOW_SIGNUP).toBe("true");
      expect(getAuth().options.secret).toBe(firstSecret);
      expect(auth.options.secret).toBe(firstSecret);
    },
  );
  try {
    await withCfEnv(
      bindings({ BETTER_AUTH_SECRET: secondSecret }),
      async () => {
        await Promise.resolve();
        expect(getAuthSecret()).toBe(secondSecret);
        expect(getAuth().options.emailAndPassword.disableSignUp).toBe(true);
      },
    );
  } finally {
    release();
    await first;
  }
});

it("accepts empty optional provider bindings from the default local profile", async () => {
  await withCfEnv(
    bindings({
      NODE_ENV: "development",
      GOOGLE_CLIENT_ID: "",
      GOOGLE_CLIENT_SECRET: "",
      E2E_GOOGLE_PROVIDER_URL: "",
      BETTER_AUTH_URL: "",
    }),
    async () => {
      expect(getAuthConfiguration()).toMatchObject({
        GOOGLE_CLIENT_ID: undefined,
        GOOGLE_CLIENT_SECRET: undefined,
        E2E_GOOGLE_PROVIDER_URL: undefined,
        BETTER_AUTH_URL: undefined,
      });
      expect(getAuth().options.socialProviders).toEqual({});
      expect(getAuth().options.emailAndPassword.enabled).toBe(true);
    },
  );
});
