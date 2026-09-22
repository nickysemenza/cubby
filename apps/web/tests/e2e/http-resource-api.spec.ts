import { z } from "zod";
import { Pool } from "pg";
import { createCubbyClient } from "~/lib/http-api/client";
import {
  settledCalendarFeedRevision,
  expectCalendarFeedDirtied,
} from "./e2e-helpers";
import { expect, test } from "./e2e-test";

const createdSchema = z.object({ item: z.object({ id: z.string() }) });
const sessionSchema = z.object({
  user: z.object({ id: z.string() }),
  session: z.object({ id: z.string(), token: z.string() }),
});

test("signed-in resource CRUD preserves fields, audit identity, and calendar effects", async ({
  page,
  baseURL,
}) => {
  const session = sessionSchema.parse(
    await (await page.request.get("/api/auth/get-session")).json(),
  );
  const origin = { Origin: baseURL! };
  const inspectFeed = async () =>
    (await page.request.get("/api/v1/calendar/inspectFeed")).json();
  const feedBefore = await settledCalendarFeedRevision(inspectFeed);
  const name = `Resource acceptance ${Date.now()}`;
  const created = await page.request.post("/api/v1/recipes", {
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
    const addressBar = await page.goto(path);
    expect(addressBar?.status()).toBe(200);
    expect(await addressBar!.json()).toMatchObject({
      id,
      name,
      notes: "Keep this",
    });
    expect(addressBar!.headers()["cache-control"]).toBe("no-store");
    const read = await page.evaluate(async () => {
      const query = new URLSearchParams({
        page: "1",
        pageSize: "1",
      });
      const response = await fetch(`/api/v1/recipes?${query}`);
      return { status: response.status, body: await response.json() };
    });
    expect(read).toMatchObject({
      status: 200,
      body: { items: expect.any(Array) },
    });
    expect(read.body.items).toHaveLength(1);
    const filtered = await page.request.get("/api/v1/recipes", {
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
    const patch = await page.evaluate(
      async ({ path }) => {
        const response = await fetch(path, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: "Renamed resource" }),
        });
        return { status: response.status, body: await response.json() };
      },
      { path },
    );
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
    const reread = await page.request.get(`/api/v1/recipes/${id}`, {
      headers: origin,
    });
    expect(await reread.json()).toMatchObject({
      id,
      name: "Renamed resource",
    });
    const audit = await page.request.get("/api/v1/auditLog/list", {
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
          await page.request.patch(path, {
            headers,
            data: { name: "Forbidden" },
          })
        ).status(),
      ).toBe(403);
      expect((await page.request.delete(path, { headers })).status()).toBe(403);
    }
    for (const key of ["invalid", ""])
      expect(
        (
          await page.request.get(path, { headers: { "x-api-key": key } })
        ).status(),
      ).toBe(401);
    expect((await fetch(`${baseURL}${path}`)).status).toBe(401);
    expect((await page.request.get("/api/v1/recipes/not-an-id")).status()).toBe(
      404,
    );
    expect((await page.request.get("/api/v1/recipes/RCP-ZZZZ")).status()).toBe(
      404,
    );
    expect((await page.request.get("/api/v1/unknown")).status()).toBe(404);
    const unsupported = await page.request.put(path, {
      headers: origin,
      data: {},
    });
    expect(unsupported.status()).toBe(405);
    expect(unsupported.headers().allow).toBe("GET, PATCH, DELETE");
    expect(
      (await page.request.get("/api/v1/recipes?page=broken")).status(),
    ).toBe(400);
    expect(
      (await page.request.get("/api/v1/recipes?page=1&page=2")).status(),
    ).toBe(400);
    expect(
      (
        await page.request.patch(path, { headers: origin, data: { name: "" } })
      ).status(),
    ).toBe(400);
    expect(
      (await page.request.get("/api/v1/recipes?filters=null")).status(),
    ).toBe(400);
    // An unsupported sort/groupBy field fails at the wire stage: the list
    // route's query schema carries the entity's roster, so ts-rest rejects
    // it as INVALID_INPUT before the kernel (whose own parseSorts/parseGroupBy
    // guard stays for MCP/RPC callers) sees the request.
    const badSort = await page.request.get("/api/v1/recipes?sort=bogus");
    expect(badSort.status()).toBe(400);
    expect(await badSort.json()).toMatchObject({
      reason: "INVALID_INPUT",
      validationIssues: [expect.objectContaining({ path: ["sort"] })],
    });
    const badGroupBy = await page.request.get("/api/v1/products?groupBy=name");
    expect(badGroupBy.status()).toBe(400);
    expect(await badGroupBy.json()).toMatchObject({
      reason: "INVALID_INPUT",
      validationIssues: [expect.objectContaining({ path: ["groupBy"] })],
    });
    const many = await page.request.get("/api/v1/recipe/getManyByIDs", {
      params: { ids: id },
    });
    expect(many.status(), await many.text()).toBe(200);
    // `/products/timeline` is a static sibling of `/products/:id`; both must
    // resolve, in that order, or the timeline reads as a missing shortcode.
    const productName = `Timeline product ${Date.now()}`;
    const productCreated = await page.request.post("/api/v1/products", {
      headers: origin,
      data: { name: productName },
    });
    expect(productCreated.status(), await productCreated.text()).toBe(201);
    const productId = createdSchema.parse(await productCreated.json()).item.id;
    try {
      const timeline = await page.request.get("/api/v1/products/timeline", {
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
      const productRead = await page.request.get(
        `/api/v1/products/${productId}`,
      );
      expect(productRead.status(), await productRead.text()).toBe(200);
      expect(await productRead.json()).toMatchObject({
        id: productId,
        name: productName,
      });
    } finally {
      expect(
        (
          await page.request.delete(`/api/v1/products/${productId}`, {
            headers: origin,
          })
        ).status(),
      ).toBe(200);
    }
  } finally {
    expect(
      (await page.request.delete(path, { headers: origin })).status(),
    ).toBe(200);
  }
  expect((await page.request.get(path)).status()).toBe(404);
});

test("typed resource and operation clients use the same generated request shapes", async ({
  page,
  baseURL,
}) => {
  const keyResponse = await page.request.post("/api/auth/api-key/create", {
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
    await page.request.post("/api/auth/api-key/delete", {
      headers: { Origin: baseURL! },
      data: { configId: "http-api", keyId: key.id },
    });
  }
});

test("a revoked session is rejected once its cookie cache is gone", async ({
  browser,
  baseURL,
}) => {
  const context = await browser.newContext({ baseURL });
  const pool = new Pool({ connectionString: process.env.E2E_DATABASE_URL });
  try {
    const login = await context.request.post("/api/auth/sign-in/email", {
      headers: { Origin: baseURL! },
      data: {
        email: process.env.E2E_TEST_USER_EMAIL,
        password: process.env.E2E_TEST_USER_PASSWORD,
      },
    });
    expect(login.status()).toBe(200);
    const session = sessionSchema.parse(
      await (await context.request.get("/api/auth/get-session")).json(),
    );
    expect((await context.request.get("/api/v1/recipes")).status()).toBe(200);
    await pool.query("DELETE FROM session WHERE id = $1", [session.session.id]);
    // The signed `session_data` cookie is authoritative for its five-minute
    // window (auth.ts `cookieCache`), so the revoked row is still honoured
    // while it lasts; the moment the cache cookie is absent the token must
    // be re-read from the database and refused.
    expect((await context.request.get("/api/v1/recipes")).status()).toBe(200);
    await context.clearCookies({ name: /session_data/ });
    expect((await context.request.get("/api/v1/recipes")).status()).toBe(401);
    expect(
      (await context.request.get("/api/v1/dashboard/counts")).status(),
    ).toBe(401);
    await context.request.post("/api/auth/sign-in/email", {
      headers: { Origin: baseURL! },
      data: {
        email: process.env.E2E_TEST_USER_EMAIL,
        password: process.env.E2E_TEST_USER_PASSWORD,
      },
    });
    const page = await context.newPage();
    expect((await page.goto("/api/v1/recipes"))?.status()).toBe(200);
    expect(
      (
        await context.request.post("/api/auth/sign-out", {
          data: {},
          headers: { Origin: baseURL! },
        })
      ).status(),
    ).toBe(200);
    expect((await page.reload())?.status()).toBe(401);
  } finally {
    await pool.end();
    await context.close();
  }
});

test("Scalar sends session-authenticated reads and writes without an API key", async ({
  page,
  baseURL,
}) => {
  await page.goto("/api/v1/docs#tag/dashboard/GET/api/v1/dashboard/counts");
  await page
    .getByRole("button", {
      name: "Test Request (get /api/v1/dashboard/counts)",
      exact: true,
    })
    .click();
  const read = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/v1/dashboard/counts") &&
      response.request().method() === "GET",
  );
  await page.getByRole("button", { name: /^Send get request/ }).click();
  const result = await read;
  expect(result.request().headers()["x-api-key"]).toBeUndefined();
  expect(Boolean((await result.request().allHeaders()).cookie)).toBe(true);
  expect(result.status(), await result.text()).toBe(200);
  await page.goto("/api/v1/docs#tag/vendor/POST/api/v1/vendors");
  await page.reload();
  await page
    .getByRole("button", {
      name: "Test Request (post /api/v1/vendors)",
      exact: true,
    })
    .click();
  await page
    .getByRole("dialog", { name: "API Client" })
    .getByRole("textbox", { name: "", exact: true })
    .first()
    .fill(JSON.stringify({ name: "Scalar session vendor" }));
  const snippet = page
    .getByRole("dialog", { name: "API Client" })
    .getByRole("region")
    .filter({ has: page.getByRole("heading", { name: /^Code Snippet/ }) })
    .last();
  await snippet.getByRole("button").click();
  await expect(snippet).toContainText("Scalar session vendor");
  const write = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/v1/vendors") &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: /^Send post request/ }).click();
  const created = await write;
  expect((await created.request().allHeaders()).origin).toBe(baseURL);
  expect(created.status(), await created.text()).toBe(201);
  const id = createdSchema.parse(await created.json()).item.id;
  await page.request.delete(`/api/v1/vendors/${id}`, {
    headers: { Origin: baseURL! },
  });
});

test("resource deletion preserves domain blockers", async ({
  page,
  baseURL,
}) => {
  const headers = { Origin: baseURL! };
  const accountResponse = await page.request.post(
    "/api/v1/financial-accounts",
    {
      headers,
      data: { name: "HTTP blocker account", identity: { kind: "cash" } },
    },
  );
  expect(accountResponse.status(), await accountResponse.text()).toBe(201);
  const accountId = createdSchema.parse(await accountResponse.json()).item.id;
  const transactionResponse = await page.request.post(
    "/api/v1/financial-transactions",
    {
      headers,
      data: {
        accountId,
        kind: "other",
        status: "posted",
        amount: 10,
        postedDate: "2026-09-10",
      },
    },
  );
  expect(transactionResponse.status(), await transactionResponse.text()).toBe(
    201,
  );
  const transactionId = createdSchema.parse(await transactionResponse.json())
    .item.id;
  try {
    const blocked = await page.request.delete(
      `/api/v1/financial-accounts/${accountId}`,
      { headers },
    );
    expect(blocked.status()).toBe(412);
    expect(await blocked.json()).toMatchObject({
      reason: "FINANCIAL_ACCOUNT_HAS_TRANSACTIONS",
      blockers: expect.any(Array),
    });
    expect(
      (
        await page.request.get(`/api/v1/financial-accounts/${accountId}`)
      ).status(),
    ).toBe(200);
  } finally {
    expect(
      (
        await page.request.delete(
          `/api/v1/financial-transactions/${transactionId}`,
          { headers },
        )
      ).status(),
    ).toBe(200);
    expect(
      (
        await page.request.delete(`/api/v1/financial-accounts/${accountId}`, {
          headers,
        })
      ).status(),
    ).toBe(200);
  }
});
