import { calendarContract } from "~/contracts/calendar.contract";
import { createPostgresPool } from "../../tooling/postgres-pool";
import { z } from "zod";

import { entityApi } from "./support/entity-api";
import { startOperation } from "./support/start-operation";
import { createCubbyClient } from "./support/http-api-client";
import {
  settledCalendarFeedRevision,
  expectCalendarFeedDirtied,
} from "./support/e2e-helpers";
import { retryStaleKeepAlive } from "../../tooling/stale-keep-alive";
import { expect, test } from "./support/e2e-test";

const createdSchema = z.object({ item: z.object({ id: z.string() }) });
const sessionSchema = z.object({
  user: z.object({ id: z.string() }),
  session: z.object({ id: z.string(), token: z.string() }),
});

// Guards lost fields on partial updates, actor attribution, and calendar invalidation.
// The loose HTTP body must still reject malformed commands at the kernel boundary.
test("kernel HTTP round trip preserves fields, audit identity, and calendar effects", async ({
  page,
  baseURL,
}) => {
  const api = entityApi(page.request);
  const headers = { Origin: baseURL! };
  const session = sessionSchema.parse(
    await (await page.request.get("/api/auth/get-session")).json(),
  );
  const inspectFeed = async () =>
    calendarContract.ops.inspectFeed.output.parse(
      (await startOperation(page.request, "calendar.inspectFeed", undefined))
        .body,
    );
  const feedBefore = await settledCalendarFeedRevision(inspectFeed);
  const name = `Kernel acceptance ${Date.now()}`;
  const created = await api.create(
    "vendor",
    { name, notes: "Keep this" },
    { headers },
  );
  expect(created.status(), await created.text()).toBe(200);
  const id = createdSchema.parse(created.parsedBody).item.id;
  expect(created.headers().location).toBeUndefined();
  try {
    const detail = await api.get("vendor", id);
    expect(detail.status()).toBe(200);
    expect(detail.parsedBody).toMatchObject({ id, name, notes: "Keep this" });
    expect(detail.headers()["cache-control"]).toBe("no-store");
    const updated = await api.update(
      "vendor",
      id,
      { name: `${name} renamed` },
      { headers },
    );
    expect(updated.status()).toBe(200);
    expect(updated.parsedBody).toMatchObject({
      item: { id, name: `${name} renamed`, notes: "Keep this" },
    });
    const list = await api.list("vendor", {
      filters: { search: name },
      pagination: { pageIndex: 0, pageSize: 1 },
      sort: [{ orderBy: "name", direction: "asc" }],
    });
    expect(list.status(), await list.text()).toBe(200);
    expect(list.parsedBody).toMatchObject({
      items: [{ id }],
      meta: { pageIndex: 0, pageSize: 1, totalCount: 1 },
    });
    const audit = await page.request.get("/api/v1/auditLog/list", {
      params: { entityKind: "vendor", entityId: id, channel: "api" },
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
    for (const origin of [undefined, "https://foreign.example"]) {
      const deniedHeaders: Record<string, string> = origin
        ? { Origin: origin }
        : {};
      expect(
        (
          await api.update(
            "vendor",
            id,
            { name: "Forbidden" },
            { headers: deniedHeaders },
          )
        ).status(),
      ).toBe(403);
      expect(
        (await api.remove("vendor", id, { headers: deniedHeaders })).status(),
      ).toBe(403);
    }
    for (const key of ["invalid", ""]) {
      expect(
        (
          await api.get("vendor", id, { headers: { "x-api-key": key } })
        ).status(),
      ).toBe(401);
    }
    expect(
      (
        await fetch(`${baseURL}/api/v1/entity/detail`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ entity: "vendor", shortcode: id }),
        })
      ).status,
    ).toBe(401);
    const missing = await api.get("vendor", "VEN-ZZZZ");
    expect(missing.status()).toBe(404);
    expect(missing.parsedBody).toMatchObject({ code: "NOT_FOUND" });
    for (const body of [
      { action: "unknown", entity: "vendor" },
      { action: "create", data: { name: "Never created" } },
    ]) {
      const bad = await page.request.post("/api/v1/entity/mutate", {
        headers,
        data: body,
      });
      expect(bad.status()).toBe(400);
      expect(await bad.json()).toMatchObject({
        code: "BAD_REQUEST",
        validationIssues: expect.any(Array),
      });
    }
    // A misspelled filter must fail, not return the unfiltered list.
    const typo = await api.list(
      "vendor",
      { filters: { searchQuerry: "Synthetic" } },
      { headers },
    );
    expect(typo.status()).toBe(400);
    expect(typo.parsedBody).toMatchObject({
      code: "BAD_REQUEST",
      validationIssues: expect.any(Array),
    });
    const unsupported = await page.request.get("/api/v1/entity/detail");
    expect(unsupported.status()).toBe(405);
    expect(unsupported.headers().allow).toBe("POST");
    // Vendor has no dated timeline; Product exercises the timeline kernel on its declared shape.
    const product = await api.create(
      "product",
      { name: `Kernel timeline ${Date.now()}` },
      { headers },
    );
    expect(product.status()).toBe(200);
    const productId = createdSchema.parse(product.parsedBody).item.id;
    try {
      const timeline = await api.timeline("product", {
        window: { ids: [productId], order: "asc" },
      });
      expect(timeline.status(), await timeline.text()).toBe(200);
      expect(timeline.parsedBody).toMatchObject({
        groups: expect.any(Array),
        stats: expect.arrayContaining([
          expect.objectContaining({ key: "products", value: "1" }),
        ]),
        notes: expect.any(Array),
      });
    } finally {
      expect(
        (await api.remove("product", productId, { headers })).status(),
      ).toBe(200);
    }
  } finally {
    expect((await api.remove("vendor", id, { headers })).status()).toBe(200);
  }
  expect((await api.get("vendor", id)).status()).toBe(404);
});

test("typed kernel client preserves zero-based pagination and literal filters", async ({
  page,
  baseURL,
}) => {
  const keyResponse = await page.request.post("/api/auth/api-key/create", {
    headers: { Origin: baseURL! },
    data: { name: "Kernel client", configId: "http-api" },
  });
  const key = z
    .object({ id: z.string(), key: z.string() })
    .parse(await keyResponse.json());
  const client = createCubbyClient({ baseUrl: baseURL!, apiKey: key.key });
  const ids: string[] = [];
  try {
    const prefix = `Kernel page ${Date.now()}`;
    for (const suffix of ["A", "B"]) {
      const created = await client.entity.mutate({
        body: {
          action: "create",
          entity: "vendor",
          data: { name: `${prefix} ${suffix}` },
        },
      });
      expect(created.status).toBe(200);
      ids.push(createdSchema.parse(created.body).item.id);
    }
    const second = await client.entity.list({
      body: {
        entity: "vendor",
        filters: { search: prefix },
        pagination: { pageIndex: 1, pageSize: 1 },
        sort: [{ orderBy: "name", direction: "asc" }],
      },
    });
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({
      items: [{ id: ids[1] }],
      meta: { pageIndex: 1, totalCount: 2 },
    });
    expect(
      (
        await client.entity.detail({
          body: { entity: "vendor", shortcode: ids[0] },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await client.entity.mutate({
          body: {
            action: "update",
            entity: "vendor",
            id: ids[0],
            data: { name: '"123"' },
          },
        })
      ).status,
    ).toBe(200);
    const literal = await client.entity.list({
      body: { entity: "vendor", filters: { search: '"123"' } },
    });
    expect(literal.body).toMatchObject({ items: [{ id: ids[0] }] });
  } finally {
    for (const id of ids)
      expect(
        (
          await client.entity.mutate({
            body: { action: "delete", entity: "vendor", ids: [id] },
          })
        ).status,
      ).toBe(200);
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
  retryStaleKeepAlive(context.request);
  const api = entityApi(context.request);
  const pool = createPostgresPool({
    connectionString: process.env.E2E_DATABASE_URL,
  });
  const login = () =>
    context.request.post("/api/auth/sign-in/email", {
      headers: { Origin: baseURL! },
      data: {
        email: process.env.E2E_TEST_USER_EMAIL,
        password: process.env.E2E_TEST_USER_PASSWORD,
      },
    });
  try {
    expect((await login()).status()).toBe(200);
    const session = sessionSchema.parse(
      await (await context.request.get("/api/auth/get-session")).json(),
    );
    expect((await api.list("recipe")).status()).toBe(200);
    await pool.query("DELETE FROM session WHERE id = $1", [session.session.id]);
    // The signed cache remains authoritative until the cache cookie is gone.
    expect((await api.list("recipe")).status()).toBe(200);
    await context.clearCookies({ name: /session_data/ });
    expect((await api.list("recipe")).status()).toBe(401);
    expect((await login()).status()).toBe(200);
    expect((await api.list("recipe")).status()).toBe(200);
    expect(
      (
        await context.request.post("/api/auth/sign-out", {
          data: {},
          headers: { Origin: baseURL! },
        })
      ).status(),
    ).toBe(200);
    expect((await api.list("recipe")).status()).toBe(401);
  } finally {
    await pool.end();
    await context.close();
  }
});
