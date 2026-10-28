import { vendorOut } from "@cubby/schemas/entities/vendor";
import { request } from "@playwright/test";

import { z } from "zod";

import { browserOperationPath } from "~/lib/browser-operation-path";

import { entityApi } from "./support/entity-api";
import { expect, test } from "./support/e2e-test";

test("browser dispatch restores plain JSON dates and gates outdated Apple writes", async ({
  page,
  baseURL,
}) => {
  const api = entityApi(page.request);
  const headers = { Origin: baseURL! };
  const name = `Operation date ${Date.now()}`;
  const created = await api.create("vendor", { name }, { headers });
  expect(created.status(), await created.text()).toBe(200);
  const shortcode = z
    .object({ item: z.object({ id: z.string() }) })
    .parse(created.parsedBody).item.id;
  const outdatedHeaders = {
    Origin: baseURL!,
    "User-Agent": "cubby-apple/0.0.0 (iOS; synthetic-install)",
    "x-cubby-surface": "browser",
  };
  try {
    const read = await page.request.post(
      browserOperationPath("entity.detail"),
      {
        data: {
          operation: "entity.detail",
          input: { entity: "vendor", shortcode },
        },
        headers: outdatedHeaders,
      },
    );
    const readBody = await read.json();
    expect(read.status(), JSON.stringify(readBody)).toBe(200);
    const result = z
      .object({ ok: z.literal(true), data: vendorOut })
      .parse(readBody).data;
    expect(result.id).toBe(shortcode);
    // The shared dateTime schema restores the ISO string on parse.
    expect(result.createdAt).toBeInstanceOf(Date);

    // The stale write body is invalid for this operation; the runner's gate must
    // refuse it before parsing the operation-specific input.
    const write = await page.request.post(
      browserOperationPath("ai.pauseSuggestionSweep"),
      {
        data: {
          operation: "ai.pauseSuggestionSweep",
          input: "invalid-for-the-operation",
        },
        headers: outdatedHeaders,
      },
    );
    expect(write.status()).toBe(426);
    expect(await write.json()).toMatchObject({
      code: "UPGRADE_REQUIRED",
      reason: "CLIENT_UPDATE_REQUIRED",
    });

    const mismatch = await page.request.post(
      browserOperationPath("dashboard.counts"),
      {
        data: { operation: "auditLog.list", input: { limit: 5 } },
        headers: { ...outdatedHeaders, "User-Agent": "cubby-cli/1.0.0" },
      },
    );
    // Every client reads a refusal as the bare error under its status.
    expect(mismatch.status()).toBe(400);
    expect(await mismatch.json()).toMatchObject({
      code: "BAD_REQUEST",
      reason: "INVALID_INPUT",
    });

    const retired = await page.request.post("/api/browser/dispatch", {
      data: { operation: "auditLog.list", input: { limit: 5 } },
      headers: { Origin: baseURL! },
    });
    expect(retired.status()).toBe(404);
  } finally {
    expect((await api.remove("vendor", shortcode, { headers })).status()).toBe(
      200,
    );
  }
});

test("JSON operation calls round-trip entities and enforce HTTP auth", async ({
  page,
  baseURL,
}) => {
  const api = entityApi(page.request);
  const headers = { Origin: baseURL! };
  const name = `Operation wire ${Date.now()}`;
  const created = await api.create("vendor", { name }, { headers });
  expect(created.status(), await created.text()).toBe(200);
  const id = z
    .object({ item: z.object({ id: z.string() }) })
    .parse(created.parsedBody).item.id;

  try {
    const detail = await api.get("vendor", id, { headers });
    expect(detail.status(), await detail.text()).toBe(200);
    expect(detail.parsedBody).toMatchObject({ id, name });

    const updated = await api.update(
      "vendor",
      id,
      { name: `${name} updated` },
      { headers },
    );
    expect(updated.status()).toBe(200);
    expect(updated.parsedBody).toMatchObject({
      item: { id, name: `${name} updated` },
    });

    const list = await api.list(
      "vendor",
      {
        filters: { search: name },
        pagination: { pageIndex: 0, pageSize: 1 },
      },
      { headers },
    );
    expect(list.status()).toBe(200);
    expect(list.parsedBody).toMatchObject({
      items: [expect.objectContaining({ id })],
      meta: { totalCount: 1 },
    });

    const invalidKey = await page.request.post(
      browserOperationPath("entity.mutate"),
      {
        data: {
          operation: "entity.mutate",
          input: { action: "update", entity: "vendor", id, data: {} },
        },
        headers: { ...headers, "x-api-key": "cubby_invalid-synthetic-key" },
      },
    );
    expect(invalidKey.status()).toBe(401);

    const foreignCookieWrite = await api.update(
      "vendor",
      id,
      { name: "Rejected cross-origin write" },
      { headers: { Origin: "https://example.invalid" } },
    );
    expect(foreignCookieWrite.status()).toBe(403);

    const anonymous = await request.newContext({
      baseURL: baseURL!,
      storageState: { cookies: [], origins: [] },
    });
    try {
      const anonymousWrite = await anonymous.post(
        browserOperationPath("entity.mutate"),
        {
          data: {
            operation: "entity.mutate",
            input: { action: "update", entity: "vendor", id, data: {} },
          },
          headers,
        },
      );
      expect(anonymousWrite.status()).toBe(401);
    } finally {
      await anonymous.dispose();
    }
  } finally {
    expect((await api.remove("vendor", id, { headers })).status()).toBe(200);
  }
});
