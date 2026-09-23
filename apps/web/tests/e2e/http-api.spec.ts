import { createHash, randomBytes } from "node:crypto";
import { request as apiRequest } from "@playwright/test";
import { z } from "zod";
import { Pool } from "pg";
import { createCubbyClient } from "~/lib/http-api/client";
import {
  settledCalendarFeedRevision,
  expectCalendarFeedDirtied,
} from "./e2e-helpers";
import { expect, test } from "./e2e-test";

const keyResult = z.object({
  id: z.string(),
  key: z.string(),
  referenceId: z.string(),
});
const entityCreated = z.object({ item: z.object({ id: z.string() }) });
const nativeTransfer = z.object({ electron_authorization_code: z.string() });

test("API keys execute typed operations, preserve validation, and revoke immediately", async ({
  page,
  baseURL,
}) => {
  const keyResponse = await page.request.post("/api/auth/api-key/create", {
    data: { name: "HTTP acceptance", configId: "http-api" },
    headers: { Origin: baseURL! },
  });
  expect(keyResponse.status()).toBe(200);
  const key = keyResult.parse(await keyResponse.json());
  const client = createCubbyClient({ baseUrl: baseURL!, apiKey: key.key });
  const headers = { "x-api-key": key.key };
  try {
    const pool = new Pool({ connectionString: process.env.E2E_DATABASE_URL });
    try {
      const stored = await pool.query<{
        key: string;
        rate_limit_enabled: boolean;
        remaining: number | null;
      }>(
        "SELECT key, rate_limit_enabled, remaining FROM apikey WHERE id = $1",
        [key.id],
      );
      expect(stored.rows[0]).toEqual({
        key: expect.not.stringContaining("cubby_"),
        rate_limit_enabled: false,
        remaining: null,
      });
      await pool.query(
        "UPDATE apikey SET config_id = 'default' WHERE id = $1",
        [key.id],
      );
      expect((await client.dashboard.counts({ query: {} })).status).toBe(401);
      await pool.query(
        "UPDATE apikey SET config_id = 'http-api' WHERE id = $1",
        [key.id],
      );
      const expiredResponse = await page.request.post(
        "/api/auth/api-key/create",
        {
          headers: { Origin: baseURL! },
          data: {
            name: "Expired fixture",
            configId: "http-api",
            expiresIn: 86400,
          },
        },
      );
      const expired = keyResult.parse(await expiredResponse.json());
      await pool.query(
        "UPDATE apikey SET expires_at = NOW() - INTERVAL '1 second' WHERE id = $1",
        [expired.id],
      );
      expect(
        (
          await createCubbyClient({
            baseUrl: baseURL!,
            apiKey: expired.key,
          }).dashboard.counts({ query: {} })
        ).status,
      ).toBe(401);
    } finally {
      await pool.end();
    }
    const counts = await client.dashboard.counts({ query: {} });
    expect(counts.status).toBe(200);
    if (counts.status !== 200) throw new Error("Dashboard failed");
    expect(Object.keys(counts.body).length).toBeGreaterThan(0);
    const inspectFeed = async () => {
      const calendar = await client.calendar.inspectFeed({ query: {} });
      return calendar.status === 200 ? calendar.body : null;
    };
    const feedBefore = await settledCalendarFeedRevision(inspectFeed);
    const created = await page.request.post("/api/v1/vendors", {
      headers,
      data: { name: `HTTP fixture ${Date.now()}` },
    });
    expect(created.status()).toBe(201);
    const result = entityCreated.parse(await created.json());
    await expectCalendarFeedDirtied(
      inspectFeed,
      "api.entity.mutate",
      feedBefore,
    );
    const domainError = await page.request.patch("/api/v1/vendors/VEN-ZZZZ", {
      headers,
      data: { name: "Missing" },
    });
    expect(domainError.status()).toBe(404);
    expect(await domainError.json()).toMatchObject({ code: "NOT_FOUND" });
    const detail = await page.request.get(`/api/v1/vendors/${result.item.id}`, {
      headers,
    });
    expect(detail.status()).toBe(200);
    const audit = await client.auditLog.list({
      query: {
        entityType: "vendor",
        entityId: result.item.id,
        channel: "api",
      },
    });
    expect(audit.status).toBe(200);
    if (audit.status !== 200) throw new Error("Audit failed");
    expect(audit.body.entries).toEqual([
      expect.objectContaining({
        channel: "api",
        action: "create",
        userId: key.referenceId,
        createdAt: expect.stringMatching(/^\d{4}-/u),
      }),
    ]);
    const malformed = await page.request.post("/api/v1/vendors", {
      headers: { ...headers, "content-type": "application/json" },
      data: "{",
    });
    expect(malformed.status()).toBe(400);
    const badInput = await page.request.get("/api/v1/vendors", {
      headers,
      params: { page: "nope" },
    });
    expect(badInput.status()).toBe(400);
    const badId = await page.request.get("/api/v1/vendors/invalid", {
      headers,
    });
    expect(badId.status()).toBe(404);
    const spoof = await page.request.get("/api/v1/dashboard/counts", {
      headers,
      params: { actor: '{"source":"ui"}' },
    });
    expect(spoof.status()).toBe(400);
    const wrongMethod = await page.request.post("/api/v1/dashboard/counts", {
      headers,
      data: {},
    });
    expect(wrongMethod.status()).toBe(405);
    // Auth ordering on a mutation route: a cookie session without a matching
    // Origin is rejected before the body is looked at, and an invalid key is
    // an authentication failure rather than a validation one.
    const mutateBody = { name: "Never created" };
    await expect
      .poll(async () => {
        return (
          await page.request.post("/api/v1/vendors", { data: mutateBody })
        ).status();
      })
      .toBe(403);
    expect(
      (
        await page.request.post("/api/v1/vendors", {
          headers: { "x-api-key": "invalid" },
          data: mutateBody,
        })
      ).status(),
    ).toBe(401);
    expect(
      (
        await page.request.post("/api/v1/missing/operation", {
          headers,
          data: {},
        })
      ).status(),
    ).toBe(404);
    expect(
      (
        await page.request.post("/api/v1/product/createMany", {
          headers,
          data: {},
        })
      ).status(),
    ).toBe(404);
    expect(
      (
        await page.request.get("/api/v1/dashboard/counts", { headers })
      ).status(),
    ).toBe(200);
  } finally {
    expect(
      (
        await page.request.post("/api/auth/api-key/delete", {
          data: { keyId: key.id, configId: "http-api" },
          headers: { Origin: baseURL! },
        })
      ).status(),
    ).toBe(200);
  }
  expect((await client.dashboard.counts({ query: {} })).status).toBe(401);
});

test("Scalar renders generated operations and account settings expose API keys", async ({
  page,
  baseURL,
}) => {
  await page.goto("/api/v1/docs");
  await expect(
    page.getByText("Cubby API", { exact: true }).first(),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Open Group - dashboard", exact: true })
    .click();
  await expect(
    page.getByText("/api/v1/dashboard/counts", { exact: false }).first(),
  ).toBeVisible();
  await page.goto("/account/api-keys");
  await expect(
    page.getByRole("button", { name: "Create API Key", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Create API Key", exact: true })
    .click();
  await page.getByLabel("Name", { exact: true }).fill("Scalar acceptance");
  const createdKey = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api-key/create") &&
      response.request().method() === "POST",
  );
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Create API Key", exact: true })
    .click();
  const response = await createdKey;
  expect(response.status()).toBe(200);
  const key = keyResult.parse(await response.json());
  expect(key.key).toMatch(/^cubby_/u);
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await expect(
    page.getByText("Scalar acceptance", { exact: true }),
  ).toBeVisible();
  await page.goto("/api/v1/docs#tag/dashboard/GET/api/v1/dashboard/counts");
  await page
    .getByRole("button", {
      name: "Test Request (get /api/v1/dashboard/counts)",
      exact: true,
    })
    .click();
  await page
    .getByRole("dialog", { name: "API Client" })
    .getByRole("button", {
      name: "Selected Auth Type: sessionCookie",
      exact: true,
    })
    .click();
  await page.getByText("apiKey", { exact: true }).last().click();
  await page
    .getByRole("dialog", { name: "API Client" })
    .getByRole("textbox", { name: "Value", exact: true })
    .fill(key.key);
  const sent = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/v1/dashboard/counts") &&
      response.request().method() === "GET",
  );
  await page.getByRole("button", { name: /^Send get request/ }).click();
  expect((await sent).status()).toBe(200);
  await page.reload();
  await page
    .getByRole("button", {
      name: "Test Request (get /api/v1/dashboard/counts)",
      exact: true,
    })
    .click();
  await page
    .getByRole("dialog", { name: "API Client" })
    .getByRole("button", {
      name: "Selected Auth Type: sessionCookie",
      exact: true,
    })
    .click();
  await page.getByText("apiKey", { exact: true }).last().click();
  await expect(
    page
      .getByRole("dialog", { name: "API Client" })
      .getByRole("textbox", { name: "Value", exact: true }),
  ).toHaveValue("");
  await page.goto("/account/api-keys");
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Delete", exact: true })
    .click();
  await expect(
    page.getByText("Scalar acceptance", { exact: true }),
  ).toHaveCount(0);
  expect(
    (
      await createCubbyClient({
        baseUrl: baseURL!,
        apiKey: key.key,
      }).dashboard.counts({ query: {} })
    ).status,
  ).toBe(401);
});

test("bearer tokens authenticate a cookie-less native client", async ({
  baseURL,
}) => {
  // Fresh API contexts with no storage state, which is what a native app looks
  // like to the server. Auth endpoints reject untrusted Origins, so the app
  // identifies itself by its URL scheme (the `cubby-mobile://` entry in
  // trustedOrigins), as Better Auth's own native clients do. The HTTP API
  // itself needs no Origin for bearer requests.
  //
  // The test runner applies this project's `storageState` to new request
  // contexts, so the fixture cookies are cleared explicitly. Contexts also keep
  // a cookie jar, so the sign-in response would leave `login` holding a session
  // cookie; every bearer assertion runs from `native`, which never sees that
  // cookie, so only the header can authenticate it.
  const cookieless = { baseURL, storageState: { cookies: [], origins: [] } };
  const login = await apiRequest.newContext(cookieless);
  const native = await apiRequest.newContext(cookieless);
  const appOrigin = { Origin: "cubby-mobile://" };
  try {
    const signedIn = await login.post("/api/auth/sign-in/email", {
      headers: appOrigin,
      data: {
        email: process.env.E2E_TEST_USER_EMAIL,
        password: process.env.E2E_TEST_USER_PASSWORD,
      },
    });
    expect(signedIn.status(), await signedIn.text()).toBe(200);
    const token = signedIn.headers()["set-auth-token"];
    expect(token).toMatch(/^\S+\.\S+$/u);
    await login.dispose();
    const bearer = { Authorization: `Bearer ${token}` };

    expect((await native.get("/api/v1/recipes")).status()).toBe(401);
    const read = await native.get("/api/v1/recipes", {
      headers: bearer,
      params: { page: "1", pageSize: "1" },
    });
    expect(read.status(), await read.text()).toBe(200);
    expect(await read.json()).toMatchObject({ items: expect.any(Array) });

    const created = await native.post("/api/v1/recipes", {
      headers: bearer,
      data: {
        name: `Bearer acceptance ${Date.now()}`,
        meta: null,
        sections: [],
      },
    });
    expect(created.status(), await created.text()).toBe(201);
    const id = entityCreated.parse(await created.json()).item.id;
    expect(
      (
        await native.delete(`/api/v1/recipes/${id}`, { headers: bearer })
      ).status(),
    ).toBe(200);

    expect(
      (
        await native.get("/api/v1/recipes", {
          headers: { Authorization: "Bearer invalid.token" },
        })
      ).status(),
    ).toBe(401);

    // Sign-out revokes the session; the boundary reads sessions from the
    // database on every request, so the old token stops working at once.
    expect(
      (
        await native.post("/api/auth/sign-out", {
          headers: { ...bearer, ...appOrigin },
          data: {},
        })
      ).status(),
    ).toBe(200);
    expect(
      (await native.get("/api/v1/recipes", { headers: bearer })).status(),
    ).toBe(401);
  } finally {
    await login.dispose();
    await native.dispose();
  }
});

test("native handoff exchanges PKCE once for a signed API session", async ({
  page,
  baseURL,
}) => {
  const cookieless = { baseURL, storageState: { cookies: [], origins: [] } };
  const exchange = await apiRequest.newContext(cookieless);
  const native = await apiRequest.newContext(cookieless);
  const origin = { Origin: "cubby-mobile://" };
  const verifier = randomBytes(32).toString("base64url");
  const state = randomBytes(32).toString("base64url");
  const params = new URLSearchParams({
    client_id: "cubby-native",
    state,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
  });
  const createCode = async () => {
    const response = await page.request.post(
      `/api/auth/electron/transfer-user?${params}`,
      { headers: { Origin: baseURL! }, data: {} },
    );
    expect(response.status(), await response.text()).toBe(200);
    return nativeTransfer.parse(await response.json())
      .electron_authorization_code;
  };
  let signedToken: string | undefined;
  try {
    const token = await createCode();
    const body = { token, state, code_verifier: verifier };
    const response = await exchange.post("/api/auth/electron/token", {
      headers: origin,
      data: body,
    });
    expect(response.status(), await response.text()).toBe(200);
    signedToken = response.headers()["set-auth-token"];
    expect(signedToken).toMatch(/^\S+\.\S+$/u);

    // A separate cookie-less context proves the plugin's signed header, not
    // the exchange response's ambient cookies, authenticates the native API.
    const read = await native.get("/api/v1/recipes", {
      headers: { Authorization: `Bearer ${signedToken}` },
      params: { page: "1", pageSize: "1" },
    });
    expect(read.status(), await read.text()).toBe(200);
    const rawToken = z
      .object({ token: z.string() })
      .parse(await response.json()).token;
    expect(
      (
        await native.get("/api/v1/recipes", {
          headers: { Authorization: `Bearer ${rawToken}` },
        })
      ).status(),
    ).toBe(401);
    expect(
      (
        await exchange.post("/api/auth/electron/token", {
          headers: origin,
          data: body,
        })
      ).status(),
    ).toBe(404);

    const wrongVerifier = await exchange.post("/api/auth/electron/token", {
      headers: origin,
      data: {
        token: await createCode(),
        state,
        code_verifier: randomBytes(32).toString("base64url"),
      },
    });
    expect(wrongVerifier.status()).toBe(400);
    expect(wrongVerifier.headers()["set-auth-token"]).toBeUndefined();
  } finally {
    if (signedToken) {
      await native.post("/api/auth/sign-out", {
        headers: { ...origin, Authorization: `Bearer ${signedToken}` },
        data: {},
      });
    }
    await exchange.dispose();
    await native.dispose();
  }
});
