/**
 * The core entity browser runtime uses named operations
 * (docs/entities.md, "Transports").
 *
 * One representative entity carries the contract for all of them, because the
 * list, detail, and mutation paths are generic: every compiled entity goes
 * through the same three operations. Per-entity duplication would cost
 * browser time without covering anything the generic path doesn't.
 *
 * Only the browser seam can observe this. Lower tiers see the query options and
 * the server functions, but not which requests a real page actually issues.
 */

import superjson from "superjson";

import { BROWSER_OPERATION_PATH } from "~/lib/browser-operation-path";
import { createProduct } from "./e2e-helpers";
import { expect, test } from "./e2e-test";

type BrowserOperationRequest = {
  body: string;
  entity?: string;
  kind?: string;
  method: string;
  operation?: string;
  input: unknown;
  url: string;
};

test("core entity list, detail, and mutation ride named browser operations", async ({
  page,
}) => {
  const starts: BrowserOperationRequest[] = [];
  const requestIds: string[] = [];
  const requestIdReads: Promise<void>[] = [];
  const canaryRequestId = `e2e-ray-${Date.now()}`;
  await page.setExtraHTTPHeaders({ "cf-ray": canaryRequestId });
  page.on("request", (request) => {
    const url = request.url();
    if (new URL(url).pathname !== BROWSER_OPERATION_PATH) return;
    const body = request.postData() ?? "";
    const payload = superjson.deserialize<{
      operation: string;
      input: unknown;
    }>(JSON.parse(body));
    starts.push({
      body,
      entity: request.headers()["x-cubby-operation-entity"],
      kind: request.headers()["x-cubby-operation-kind"],
      method: request.method(),
      input: payload.input,
      operation: request.headers()["x-cubby-operation"],
      url,
    });
  });
  page.on("response", (response) => {
    if (new URL(response.url()).pathname !== BROWSER_OPERATION_PATH) return;
    requestIdReads.push(
      response
        .allHeaders()
        .then((headers) => {
          const requestId = headers["x-request-id"];
          if (requestId) requestIds.push(requestId);
        })
        // A response landing after the final read below is still being read
        // when the page closes; that rejection must not fail the finished test.
        .catch(() => undefined),
    );
  });

  const name = `E2E Start Transport ${Date.now()}`;
  await createProduct(page, name);

  // In-app navigation throughout: a `page.goto` runs the route loader on the
  // server, where no browser request is issued and nothing is observable.
  await page
    .getByLabel("Workspace navigation")
    .getByRole("link", { name: /^Products(?: [\d,]+ records)?$/ })
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

  const matching = (operation: string, fragment: string) =>
    starts.filter(
      (start) =>
        start.operation === operation &&
        JSON.stringify(start.input).includes(fragment),
    );

  const report = () => JSON.stringify(starts.map((start) => start.input));
  expect(
    matching("entity.mutate", '"action":"create"'),
    `entity.mutate should carry the create:\n${report()}`,
  ).not.toHaveLength(0);
  expect(
    matching("entity.list", '"pageIndex"'),
    `entity.list should carry the product page:\n${report()}`,
  ).not.toHaveLength(0);
  const detailRequests = matching("entity.detail", '"entity":"product"');
  expect(
    detailRequests,
    `entity.detail should carry the product shortcode:\n${report()}`,
  ).not.toHaveLength(0);
  for (const request of detailRequests) {
    expect(request.method).toBe("POST");
    const detailUrl = new URL(request.url);
    expect(detailUrl.pathname).toBe(BROWSER_OPERATION_PATH);
    expect(detailUrl.search).toBe("");
    expect(request.input).toEqual(
      expect.objectContaining({
        entity: "product",
        shortcode: expect.any(String),
      }),
    );
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
  for (const start of starts) expect(start.operation).toBeDefined();

  // The list may fetch another row's detail before the click (the first row,
  // from a sibling spec's fixture), so replay this product's own request.
  const shortcode = new URL(page.url()).pathname.split("/").at(-1)!;
  const detail = detailRequests.find((request) =>
    JSON.stringify(request.input).includes(shortcode),
  );
  if (!detail) throw new Error(`Expected a detail request for ${shortcode}`);
  expect(detail.operation).toBe("entity.detail");

  // Response-owned ids, rather than a shared module-global "last id", make
  // each completed browser request independently searchable in traces.
  await Promise.all(requestIdReads);
  expect(requestIds.length).toBeGreaterThanOrEqual(3);
  for (const requestId of requestIds) expect(requestId).toBe(canaryRequestId);
});

test("server error references remain usable on desktop", async ({
  page,
  context,
}, testInfo) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/");
  await page.route(`**${BROWSER_OPERATION_PATH}`, async (route) => {
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
    .getByRole("link", { name: /^Products(?: [\d,]+ records)?$/ })
    .click();
  await expect(
    page.getByText("Server request failed (HTTP 500)", { exact: true }).first(),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Details", exact: true })
    .first()
    .click();
  const dialog = page.getByRole("dialog", { name: "Technical details" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("entity.list / dispatch");
  await expect(
    dialog.getByRole("link", { name: "View in Sentry" }),
  ).toHaveAttribute(
    "href",
    "https://nicky-semenza.sentry.io/issues/?query=0123456789abcdef0123456789abcdef",
  );
  // The source toast is dismissed when its "Details" action opens the dialog
  // (sonner's default post-onClick behavior), so there is exactly one dialog
  // and no leftover "Details" button behind it.
  await expect(
    page.getByRole("button", { name: "Details", exact: true }),
  ).toHaveCount(0);
  await dialog.getByRole("button", { name: "Copy details" }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain(
    "diagnostic-test-request",
  );
  await expect(dialog.getByRole("button", { name: "Copied" })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("error-desktop.png") });
});
