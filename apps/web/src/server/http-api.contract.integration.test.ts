import { createHash, randomBytes } from "node:crypto";

import {
  request as apiRequest,
  expect,
  type APIRequestContext,
} from "@playwright/test";
import { Pool } from "pg";
import { afterAll, beforeAll, it } from "vitest";
import { z } from "zod";

import { createCubbyClient } from "~/lib/http-api/client";

import { prepareE2EDatabaseTemplate } from "../../tests/e2e/e2e-database";
import {
  settledCalendarFeedRevision,
  expectCalendarFeedDirtied,
} from "../../tests/e2e/e2e-helpers";
import { prepareE2EWranglerConfig } from "../../tests/e2e/e2e-worker-config";
import {
  createE2EWorkerRuntime,
  type E2EWorkerRuntime,
} from "../../tests/e2e/e2e-worker-runtime";

const keyResult = z.object({
  id: z.string(),
  key: z.string(),
  referenceId: z.string(),
});
const entityCreated = z.object({ item: z.object({ id: z.string() }) });
const nativeTransfer = z.object({ electron_authorization_code: z.string() });
const createdSchema = z.object({ item: z.object({ id: z.string() }) });
const sessionSchema = z.object({
  user: z.object({ id: z.string() }),
  session: z.object({ id: z.string(), token: z.string() }),
});

let runtime: E2EWorkerRuntime;
let api: APIRequestContext;
const email = "http-contract@example.test";
const password = "http-contract-password";
const previousAuth = {
  email: process.env.E2E_TEST_USER_EMAIL,
  password: process.env.E2E_TEST_USER_PASSWORD,
};

beforeAll(async () => {
  process.env.E2E_TEST_USER_EMAIL = email;
  process.env.E2E_TEST_USER_PASSWORD = password;
  prepareE2EWranglerConfig();
  await prepareE2EDatabaseTemplate();
  runtime = await createE2EWorkerRuntime({
    authenticated: true,
    parallelIndex: 0,
  });
  api = await apiRequest.newContext({
    baseURL: runtime.baseURL,
    storageState: runtime.storageState,
  });
}, 120_000);

afterAll(async () => {
  await api?.dispose();
  await runtime?.close();
  if (previousAuth.email === undefined) delete process.env.E2E_TEST_USER_EMAIL;
  else process.env.E2E_TEST_USER_EMAIL = previousAuth.email;
  if (previousAuth.password === undefined)
    delete process.env.E2E_TEST_USER_PASSWORD;
  else process.env.E2E_TEST_USER_PASSWORD = previousAuth.password;
});

it("API keys execute typed operations, preserve validation, and revoke immediately", async () => {
  const baseURL = runtime.baseURL;
  const keyResponse = await api.post("/api/auth/api-key/create", {
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
      const expiredResponse = await api.post("/api/auth/api-key/create", {
        headers: { Origin: baseURL! },
        data: {
          name: "Expired fixture",
          configId: "http-api",
          expiresIn: 86400,
        },
      });
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
    const created = await api.post("/api/v1/vendors", {
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
    const domainError = await api.patch("/api/v1/vendors/VEN-ZZZZ", {
      headers,
      data: { name: "Missing" },
    });
    expect(domainError.status()).toBe(404);
    expect(await domainError.json()).toMatchObject({ code: "NOT_FOUND" });
    const detail = await api.get(`/api/v1/vendors/${result.item.id}`, {
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
    const malformed = await api.post("/api/v1/vendors", {
      headers: { ...headers, "content-type": "application/json" },
      data: "{",
    });
    expect(malformed.status()).toBe(400);
    const badInput = await api.get("/api/v1/vendors", {
      headers,
      params: { page: "nope" },
    });
    expect(badInput.status()).toBe(400);
    const badId = await api.get("/api/v1/vendors/invalid", {
      headers,
    });
    expect(badId.status()).toBe(404);
    const spoof = await api.get("/api/v1/dashboard/counts", {
      headers,
      params: { actor: '{"source":"ui"}' },
    });
    expect(spoof.status()).toBe(400);
    const wrongMethod = await api.post("/api/v1/dashboard/counts", {
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
          await api.post("/api/v1/vendors", { data: mutateBody })
        ).status();
      })
      .toBe(403);
    expect(
      (
        await api.post("/api/v1/vendors", {
          headers: { "x-api-key": "invalid" },
          data: mutateBody,
        })
      ).status(),
    ).toBe(401);
    expect(
      (
        await api.post("/api/v1/missing/operation", {
          headers,
          data: {},
        })
      ).status(),
    ).toBe(404);
    expect(
      (
        await api.post("/api/v1/product/createMany", {
          headers,
          data: {},
        })
      ).status(),
    ).toBe(404);
    expect(
      (await api.get("/api/v1/dashboard/counts", { headers })).status(),
    ).toBe(200);
  } finally {
    expect(
      (
        await api.post("/api/auth/api-key/delete", {
          data: { keyId: key.id, configId: "http-api" },
          headers: { Origin: baseURL! },
        })
      ).status(),
    ).toBe(200);
  }
  expect((await client.dashboard.counts({ query: {} })).status).toBe(401);
}, 30_000);

it("bearer tokens authenticate a cookie-less native client", async () => {
  const baseURL = runtime.baseURL;
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
}, 30_000);

it("native handoff exchanges PKCE once for a signed API session", async () => {
  const baseURL = runtime.baseURL;
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
    const response = await api.post(
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
}, 30_000);

it("signed-in resource CRUD preserves fields, audit identity, and calendar effects", async () => {
  const baseURL = runtime.baseURL;
  const session = sessionSchema.parse(
    await (await api.get("/api/auth/get-session")).json(),
  );
  const origin = { Origin: baseURL! };
  const inspectFeed = async () =>
    (await api.get("/api/v1/calendar/inspectFeed")).json();
  const feedBefore = await settledCalendarFeedRevision(inspectFeed);
  const name = `Resource acceptance ${Date.now()}`;
  const created = await api.post("/api/v1/recipes", {
    headers: origin,
    data: {
      name,
      meta: null,
      sections: [],
      notes: "Keep this",
      tags: ["http-test"],
    },
  });
  expect(created.status(), await created.text()).toBe(201);
  const id = createdSchema.parse(await created.json()).item.id;
  const path = `/api/v1/recipes/${id}`;
  expect(created.headers().location).toBe(path);
  try {
    const detail = await api.get(path);
    expect(detail.status()).toBe(200);
    expect(await detail.json()).toMatchObject({
      id,
      name,
      notes: "Keep this",
    });
    expect(detail.headers()["cache-control"]).toBe("no-store");
    const listResponse = await api.get("/api/v1/recipes", {
      params: { page: "1", pageSize: "1" },
    });
    const read = {
      status: listResponse.status(),
      body: await listResponse.json(),
    };
    expect(read).toMatchObject({
      status: 200,
      body: { items: expect.any(Array) },
    });
    expect(read.body.items).toHaveLength(1);
    const filtered = await api.get("/api/v1/recipes", {
      params: {
        nameFilter: name,
        page: "1",
        pageSize: "1",
        sort: "name,-createdAt",
      },
    });
    expect(filtered.status(), await filtered.text()).toBe(200);
    expect(await filtered.json()).toMatchObject({
      items: [{ id }],
      meta: { totalCount: 1 },
    });
    const patchResponse = await api.patch(path, {
      headers: origin,
      data: { name: "Renamed resource" },
    });
    const patch = {
      status: patchResponse.status(),
      body: await patchResponse.json(),
    };
    expect(patch).toMatchObject({
      status: 200,
      body: {
        item: {
          name: "Renamed resource",
          notes: "Keep this",
          tags: ["http-test"],
        },
      },
    });
    const reread = await api.get(`/api/v1/recipes/${id}`, {
      headers: origin,
    });
    expect(await reread.json()).toMatchObject({
      id,
      name: "Renamed resource",
    });
    const audit = await api.get("/api/v1/auditLog/list", {
      params: { entityType: "recipe", entityId: id, channel: "api" },
    });
    expect(await audit.json()).toMatchObject({
      entries: expect.arrayContaining([
        expect.objectContaining({
          action: "create",
          channel: "api",
          userId: session.user.id,
        }),
        expect.objectContaining({
          action: "update",
          channel: "api",
          userId: session.user.id,
        }),
      ]),
    });
    await expectCalendarFeedDirtied(
      inspectFeed,
      "api.entity.mutate",
      feedBefore,
    );
    for (const headers of [undefined, { Origin: "https://foreign.example" }]) {
      expect(
        (
          await api.patch(path, {
            headers,
            data: { name: "Forbidden" },
          })
        ).status(),
      ).toBe(403);
      expect((await api.delete(path, { headers })).status()).toBe(403);
    }
    for (const key of ["invalid", ""])
      expect(
        (await api.get(path, { headers: { "x-api-key": key } })).status(),
      ).toBe(401);
    expect((await fetch(`${baseURL}${path}`)).status).toBe(401);
    expect((await api.get("/api/v1/recipes/not-an-id")).status()).toBe(404);
    expect((await api.get("/api/v1/recipes/RCP-ZZZZ")).status()).toBe(404);
    expect((await api.get("/api/v1/unknown")).status()).toBe(404);
    const unsupported = await api.put(path, {
      headers: origin,
      data: {},
    });
    expect(unsupported.status()).toBe(405);
    expect(unsupported.headers().allow).toBe("GET, PATCH, DELETE");
    expect((await api.get("/api/v1/recipes?page=broken")).status()).toBe(400);
    expect((await api.get("/api/v1/recipes?page=1&page=2")).status()).toBe(400);
    expect(
      (await api.patch(path, { headers: origin, data: { name: "" } })).status(),
    ).toBe(400);
    expect((await api.get("/api/v1/recipes?filters=null")).status()).toBe(400);
    // An unsupported sort/groupBy field fails at the wire stage: the list
    // route's query schema carries the entity's roster, so ts-rest rejects
    // it as INVALID_INPUT before the kernel (whose own parseSorts/parseGroupBy
    // guard stays for MCP/RPC callers) sees the request.
    const badSort = await api.get("/api/v1/recipes?sort=bogus");
    expect(badSort.status()).toBe(400);
    expect(await badSort.json()).toMatchObject({
      reason: "INVALID_INPUT",
      validationIssues: [expect.objectContaining({ path: ["sort"] })],
    });
    const badGroupBy = await api.get("/api/v1/products?groupBy=name");
    expect(badGroupBy.status()).toBe(400);
    expect(await badGroupBy.json()).toMatchObject({
      reason: "INVALID_INPUT",
      validationIssues: [expect.objectContaining({ path: ["groupBy"] })],
    });
    const many = await api.get("/api/v1/recipe/getManyByIDs", {
      params: { ids: id },
    });
    expect(many.status(), await many.text()).toBe(200);
    // `/products/timeline` is a static sibling of `/products/:id`; both must
    // resolve, in that order, or the timeline reads as a missing shortcode.
    const productName = `Timeline product ${Date.now()}`;
    const productCreated = await api.post("/api/v1/products", {
      headers: origin,
      data: { name: productName },
    });
    expect(productCreated.status(), await productCreated.text()).toBe(201);
    const productId = createdSchema.parse(await productCreated.json()).item.id;
    try {
      const timeline = await api.get("/api/v1/products/timeline", {
        params: { ids: productId, order: "asc" },
      });
      expect(timeline.status(), await timeline.text()).toBe(200);
      expect(await timeline.json()).toMatchObject({
        groups: expect.any(Array),
        stats: expect.arrayContaining([
          expect.objectContaining({ key: "products", value: "1" }),
        ]),
        notes: expect.any(Array),
      });
      const productRead = await api.get(`/api/v1/products/${productId}`);
      expect(productRead.status(), await productRead.text()).toBe(200);
      expect(await productRead.json()).toMatchObject({
        id: productId,
        name: productName,
      });
    } finally {
      expect(
        (
          await api.delete(`/api/v1/products/${productId}`, {
            headers: origin,
          })
        ).status(),
      ).toBe(200);
    }
  } finally {
    expect((await api.delete(path, { headers: origin })).status()).toBe(200);
  }
  expect((await api.get(path)).status()).toBe(404);
}, 30_000);

it("typed resource and operation clients use the same generated request shapes", async () => {
  const baseURL = runtime.baseURL;
  const keyResponse = await api.post("/api/auth/api-key/create", {
    headers: { Origin: baseURL! },
    data: { name: "Resource client", configId: "http-api" },
  });
  const key = z
    .object({ id: z.string(), key: z.string() })
    .parse(await keyResponse.json());
  const client = createCubbyClient({ baseUrl: baseURL!, apiKey: key.key });
  try {
    const counts = await client.dashboard.counts({ query: {} });
    expect(counts.status).toBe(200);
    const prefix = `Flat resource ${Date.now()}`;
    const created = await client.resources.recipe.create({
      body: { name: `${prefix} A`, meta: null, sections: [] },
    });
    expect(created.status).toBe(201);
    if (created.status !== 201) throw new Error("Create failed");
    const id = created.body.item.id;
    const second = await client.resources.recipe.create({
      body: { name: `${prefix} B`, meta: null, sections: [] },
    });
    if (second.status !== 201) throw new Error("Second create failed");
    const secondId = second.body.item.id;
    try {
      expect(
        (
          await client.resources.recipe.list({
            query: { page: 1, pageSize: 1 },
          })
        ).status,
      ).toBe(200);
      expect(
        (await client.resources.recipe.get({ params: { id } })).status,
      ).toBe(200);
      expect(
        (
          await client.resources.recipe.update({
            params: { id },
            body: { notes: "Partial" },
          })
        ).status,
      ).toBe(200);
      const pageTwo = await client.resources.recipe.list({
        query: {
          page: 2,
          pageSize: 1,
          sort: "name,-createdAt",
          nameFilter: prefix,
        },
      });
      expect(pageTwo.body).toMatchObject({
        items: [{ id: secondId }],
        meta: { pageIndex: 1, pageSize: 1, totalCount: 2 },
      });
      const descending = await client.resources.recipe.list({
        query: { pageSize: 1, sort: "-name", nameFilter: prefix },
      });
      expect(descending.body).toMatchObject({ items: [{ id: secondId }] });
      const secondPage = await client.resources.recipe.list({
        query: { nameFilter: prefix, page: 2, pageSize: 1, sort: "name" },
      });
      expect(secondPage.body).toMatchObject({
        items: [{ id: secondId }],
        meta: { pageIndex: 1 },
      });
      await client.resources.recipe.update({
        params: { id },
        body: { name: '"123"' },
      });
      const literalText = await client.resources.recipe.list({
        query: { nameFilter: '"123"' },
      });
      expect(literalText.body).toMatchObject({ items: [{ id }] });
      expect(
        (await client.recipe.getManyByIDs({ query: { ids: [id] } })).status,
      ).toBe(200);
    } finally {
      expect(
        (await client.resources.recipe.delete({ params: { id: secondId } }))
          .status,
      ).toBe(200);
      expect(
        (await client.resources.recipe.delete({ params: { id } })).status,
      ).toBe(200);
    }
  } finally {
    await api.post("/api/auth/api-key/delete", {
      headers: { Origin: baseURL! },
      data: { configId: "http-api", keyId: key.id },
    });
  }
}, 30_000);

it("a revoked session is rejected once its cookie cache is gone", async () => {
  const baseURL = runtime.baseURL;
  const context = await apiRequest.newContext({ baseURL });
  const pool = new Pool({ connectionString: runtime.databaseUrl });
  let withoutCache: APIRequestContext | undefined;
  try {
    const login = await context.post("/api/auth/sign-in/email", {
      headers: { Origin: baseURL },
      data: { email, password },
    });
    expect(login.status()).toBe(200);
    const session = sessionSchema.parse(
      await (await context.get("/api/auth/get-session")).json(),
    );
    expect((await context.get("/api/v1/recipes")).status()).toBe(200);
    await pool.query("DELETE FROM session WHERE id = $1", [session.session.id]);
    // The signed cache cookie remains authoritative until it is removed.
    expect((await context.get("/api/v1/recipes")).status()).toBe(200);
    const state = await context.storageState();
    withoutCache = await apiRequest.newContext({
      baseURL,
      storageState: {
        ...state,
        cookies: state.cookies.filter(
          (cookie) => !cookie.name.endsWith("session_data"),
        ),
      },
    });
    expect((await withoutCache.get("/api/v1/recipes")).status()).toBe(401);
    expect((await withoutCache.get("/api/v1/dashboard/counts")).status()).toBe(
      401,
    );

    expect(
      (
        await context.post("/api/auth/sign-in/email", {
          headers: { Origin: baseURL },
          data: { email, password },
        })
      ).status(),
    ).toBe(200);
    expect((await context.get("/api/v1/recipes")).status()).toBe(200);
    expect(
      (
        await context.post("/api/auth/sign-out", {
          data: {},
          headers: { Origin: baseURL },
        })
      ).status(),
    ).toBe(200);
    expect((await context.get("/api/v1/recipes")).status()).toBe(401);
  } finally {
    await withoutCache?.dispose();
    await pool.end();
    await context.dispose();
  }
}, 30_000);
