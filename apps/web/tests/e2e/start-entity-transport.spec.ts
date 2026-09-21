/**
 * The core entity browser runtime uses named Start operations
 * (docs/entities.md, "Transports").
 *
 * One representative entity carries the contract for all of them, because the
 * list, detail, and mutation paths are generic: every compiled entity goes
 * through the same three Start operations. Per-entity duplication would cost
 * browser time without covering anything the generic path doesn't.
 *
 * Only the browser seam can observe this. Lower tiers see the query options and
 * the server functions, but not which requests a real page actually issues.
 */

import { createProduct } from "./e2e-helpers";
import { expect, test } from "./e2e-test";

type StartRequest = {
  body: string;
  entity?: string;
  kind?: string;
  method: string;
  operation?: string;
  payload: string;
  url: string;
};

/**
 * Start's structured wire encoding puts object keys in a `k` array and values
 * in `{"t":…,"s":…}`, so inputs are matched by that shape rather than by plain
 * `"entity":"product"` JSON.
 */
const payloadOf = (url: string, body: string): string =>
  `${decodeURIComponent(url)}${body}`.replace(/[\\\s]/gu, "");

test("core entity list, detail, and mutation ride named Start operations", async ({
  page,
}) => {
  const starts: StartRequest[] = [];
  const requestIds: string[] = [];
  const requestIdReads: Promise<void>[] = [];
  const canaryRequestId = `e2e-ray-${Date.now()}`;
  await page.setExtraHTTPHeaders({ "cf-ray": canaryRequestId });
  page.on("request", (request) => {
    const url = request.url();
    if (!url.includes("/_serverFn/")) return;
    const body = request.postData() ?? "";
    starts.push({
      body,
      entity: request.headers()["x-cubby-operation-entity"],
      kind: request.headers()["x-cubby-operation-kind"],
      method: request.method(),
      payload: payloadOf(url, body),
      operation: request.headers()["x-cubby-operation"],
      url,
    });
  });
  page.on("response", (response) => {
    if (!response.url().includes("/_serverFn/")) return;
    requestIdReads.push(
      response.allHeaders().then((headers) => {
        const requestId = headers["x-request-id"];
        if (requestId) requestIds.push(requestId);
      }),
    );
  });

  const name = `E2E Start Transport ${Date.now()}`;
  await createProduct(page, name);

  // In-app navigation throughout: a `page.goto` runs the route loader on the
  // server, where no browser request is issued and nothing is observable.
  await page
    .getByLabel("Workspace navigation")
    .getByRole("link", { name: "Products", exact: true })
    .click();
  await expect(page).toHaveURL(/\/products$/u, { timeout: 15000 });
  await expect(page.getByRole("heading", { name: "Products" })).toBeVisible({
    timeout: 15000,
  });

  // Retried as one unit: a list table renders the outgoing rows behind an
  // `inert` body while it swaps query keys, and a click that lands in that
  // curtain fires no event while still reporting success (see `editListCell`).
  await expect(async () => {
    await page.getByRole("link", { name, exact: true }).first().click();
    await expect(page).toHaveURL(/\/products\/PRD-/u, { timeout: 5000 });
  }).toPass({ timeout: 30000 });
  await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();

  const matching = (...fragments: string[]) =>
    starts.filter((start) =>
      fragments.every((fragment) => start.payload.includes(fragment)),
    );

  const report = () => starts.map((start) => start.payload).join("\n");
  expect(
    matching('["action","entity","data"]', '"s":"create"', '"s":"product"'),
    `entity.mutate should carry the create:\n${report()}`,
  ).not.toHaveLength(0);
  expect(
    matching('"s":"product"', '"pageIndex"'),
    `entity.list should carry the product page:\n${report()}`,
  ).not.toHaveLength(0);
  const detailRequests = matching('["entity","shortcode"]', '"s":"product"');
  expect(
    detailRequests,
    `entity.detail should carry the product shortcode:\n${report()}`,
  ).not.toHaveLength(0);
  for (const request of detailRequests) {
    expect(request.method).toBe("POST");
    const detailUrl = new URL(request.url);
    expect(detailUrl.pathname).toBe("/_serverFn/dispatch");
    expect(detailUrl.searchParams.get("operation")).toBe("entity.detail");
    expect(detailUrl.searchParams.get("entity")).toBe("product");
    expect(payloadOf(request.url, "")).not.toContain('["entity","shortcode"]');
    expect(payloadOf("", request.body)).toContain('["entity","shortcode"]');
  }

  // Inputs stay in the POST body; operation labels share one dispatcher path.
  expect(
    new Set(starts.map((request) => new URL(request.url).pathname)).size,
  ).toBe(1);

  expect(starts).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        operation: "entity.mutate",
        kind: "mutation",
        entity: "product",
      }),
      expect.objectContaining({
        operation: "entity.list",
        kind: "query",
        entity: "product",
      }),
      expect.objectContaining({
        operation: "entity.detail",
        kind: "query",
        entity: "product",
      }),
    ]),
  );
  for (const start of starts) {
    expect(start.operation).toBeDefined();
    expect(new URL(start.url).searchParams.get("operation")).toBe(
      start.operation,
    );
  }

  const detail = detailRequests[0];
  if (!detail) throw new Error("Expected a compiled detail request");
  const legacy = new URL(detail.url);
  legacy.pathname =
    "/_serverFn/server-functions-start-operation-dispatch-dispatch-start-operation-server-function";
  legacy.search = "";
  const oldClientResponse = await page.request.post(legacy.toString(), {
    data: detail.body,
    headers: {
      "content-type": "application/json",
      "x-tsr-serverFn": "true",
      origin: legacy.origin,
      "sec-fetch-site": "same-origin",
    },
  });
  expect(oldClientResponse.status()).toBe(200);
  expect(await oldClientResponse.text()).toContain(name);

  // Response-owned ids, rather than a shared module-global "last id", make
  // each completed browser request independently searchable in traces.
  await Promise.all(requestIdReads);
  expect(requestIds.length).toBeGreaterThanOrEqual(3);
  for (const requestId of requestIds) expect(requestId).toBe(canaryRequestId);
});

test("server error references remain usable on desktop and narrow screens", async ({
  page,
  context,
}, testInfo) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/");
  await page.route("**/_serverFn/**", async (route) => {
    if (route.request().headers()["x-cubby-operation"] !== "entity.list") {
      await route.continue();
      return;
    }
    await route.fulfill({
      status: 500,
      headers: {
        "content-type": "text/plain",
        "x-request-id": "diagnostic-test-request",
        "x-sentry-event-id": "0123456789abcdef0123456789abcdef",
      },
      body: "Internal Server Error",
    });
  });
  await page
    .getByLabel("Workspace navigation")
    .getByRole("link", { name: "Products", exact: true })
    .click();
  await expect(
    page.getByText("Server request failed (HTTP 500)", { exact: true }).first(),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Details", exact: true })
    .first()
    .click();
  const details = page
    .locator("details")
    .filter({ hasText: "Technical details" })
    .first();
  await details.locator("summary").click();
  await expect(details).toContainText("entity.list / dispatch");
  await expect(
    details.getByRole("link", { name: "View in Sentry" }),
  ).toHaveAttribute(
    "href",
    "https://nicky-semenza.sentry.io/issues/?query=0123456789abcdef0123456789abcdef",
  );
  await details.getByRole("button", { name: "Copy details" }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain(
    "diagnostic-test-request",
  );
  await page.screenshot({ path: testInfo.outputPath("error-desktop.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(details.getByRole("button", { name: "Copied" })).toBeVisible();
  const bounds = await details.boundingBox();
  expect(bounds).not.toBeNull();
  expect((bounds?.x ?? 0) + (bounds?.width ?? 0)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: testInfo.outputPath("error-mobile.png") });
});
