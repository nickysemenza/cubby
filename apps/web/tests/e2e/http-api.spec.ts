import { z } from "zod";
import { Pool } from "pg";
import { createCubbyClient } from "~/lib/http-api/client";
import { expect, test } from "./e2e-test";

const keyResult = z.object({
  id: z.string(),
  key: z.string(),
  referenceId: z.string(),
});
const entityCreated = z.object({
  ok: z.literal(true),
  data: z.object({ item: z.object({ id: z.string() }) }),
});

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
      expect((await client.dashboard.counts({ body: {} })).status).toBe(401);
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
          }).dashboard.counts({ body: {} })
        ).status,
      ).toBe(401);
    } finally {
      await pool.end();
    }
    const counts = await client.dashboard.counts({ body: {} });
    expect(counts.status).toBe(200);
    if (counts.status !== 200) throw new Error("Dashboard failed");
    expect(counts.body.ok).toBe(true);
    const created = await page.request.post("/api/v1/entity/mutate", {
      headers,
      data: {
        input: {
          action: "create",
          entity: "vendor",
          data: { name: `HTTP fixture ${Date.now()}` },
        },
      },
    });
    expect(created.status()).toBe(200);
    const result = entityCreated.parse(await created.json());
    await expect
      .poll(async () => {
        const calendar = await client.calendar.inspectFeed({ body: {} });
        return calendar.status === 200
          ? calendar.body.data.dirty?.reason
          : undefined;
      })
      .toBe("api.entity.mutate");
    const domainError = await page.request.post("/api/v1/entity/mutate", {
      headers,
      data: {
        input: {
          action: "update",
          entity: "vendor",
          id: "VEN-ZZZZ",
          data: { name: "Missing" },
        },
      },
    });
    expect(domainError.status()).toBe(404);
    expect(await domainError.json()).toMatchObject({
      ok: false,
      error: { code: "NOT_FOUND" },
    });
    const detail = await client.entity.detail({
      body: { input: { entity: "vendor", shortcode: result.data.item.id } },
    });
    expect(detail.status).toBe(200);
    const audit = await client.auditLog.list({
      body: {
        input: {
          entityType: "vendor",
          entityId: result.data.item.id,
          source: "api",
        },
      },
    });
    expect(audit.status).toBe(200);
    if (audit.status !== 200) throw new Error("Audit failed");
    expect(audit.body.data.entries).toEqual([
      expect.objectContaining({
        source: "api",
        action: "create",
        userId: key.referenceId,
        createdAt: expect.stringMatching(/^\d{4}-/u),
      }),
    ]);
    const malformed = await page.request.post("/api/v1/dashboard/counts", {
      headers: { ...headers, "content-type": "application/json" },
      data: "{",
    });
    expect(malformed.status()).toBe(400);
    const badInput = await page.request.post("/api/v1/entity/detail", {
      headers,
      data: { input: { entity: "vendor", shortcode: "invalid" } },
    });
    expect(badInput.status()).toBe(400);
    const spoof = await page.request.post("/api/v1/dashboard/counts", {
      headers,
      data: { actor: { source: "ui" } },
    });
    expect(spoof.status()).toBe(400);
    expect(
      (
        await page.request.post("/api/v1/dashboard/counts", { data: {} })
      ).status(),
    ).toBe(401);
    expect(
      (
        await page.request.post("/api/v1/dashboard/counts", {
          headers: { "x-api-key": "invalid" },
          data: {},
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
    ).toBe(405);
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
  expect((await client.dashboard.counts({ body: {} })).status).toBe(401);
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
  await page.goto("/api/v1/docs#tag/dashboard/POST/api/v1/dashboard/counts");
  await page
    .getByRole("button", {
      name: "Test Request (post /api/v1/dashboard/counts)",
      exact: true,
    })
    .click();
  await page
    .getByRole("dialog", { name: "API Client" })
    .getByRole("textbox", { name: "Value", exact: true })
    .fill(key.key);
  const sent = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/v1/dashboard/counts") &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: /^Send post request/ }).click();
  expect((await sent).status()).toBe(200);
  await page.reload();
  await page
    .getByRole("button", {
      name: "Test Request (post /api/v1/dashboard/counts)",
      exact: true,
    })
    .click();
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
      }).dashboard.counts({ body: {} })
    ).status,
  ).toBe(401);
});
