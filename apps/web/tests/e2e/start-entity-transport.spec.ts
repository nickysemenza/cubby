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

import { z } from "zod";

import {
  BROWSER_OPERATION_PATH,
  isBrowserOperationPath,
} from "~/lib/browser-operation-path";

import { createProduct } from "./support/e2e-helpers";
import { expect, test } from "./support/e2e-test";
import { dispatchOperations, unbatchFor } from "./support/dispatch-wire";

const batchedEntity = z.object({ entity: z.string() });

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
  // Production accepts only Cloudflare-shaped rays; keep this fixture hex.
  const canaryRequestId = "0a1b2c3d4e5f6071-SJC";
  await page.setExtraHTTPHeaders({ "cf-ray": canaryRequestId });
  page.on("request", (request) => {
    const url = request.url();
    if (!isBrowserOperationPath(new URL(url).pathname)) return;
    const body = request.postData() ?? "";
    const operations = dispatchOperations(request);
    // A batch carries only queries and names each one in its body; a single
    // operation also labels itself in its trace headers.
    if (operations.length > 1) {
      for (const item of operations)
        starts.push({
          body,
          entity: batchedEntity.safeParse(item.input).data?.entity,
          kind: "query",
          method: request.method(),
          input: item.input,
          operation: item.operation,
          url,
        });
      return;
    }
    starts.push({
      body,
      entity: request.headers()["x-cubby-operation-entity"],
      kind: request.headers()["x-cubby-operation-kind"],
      method: request.method(),
      input: operations[0]?.input,
      operation: request.headers()["x-cubby-operation"],
      url,
    });
  });
  page.on("response", (response) => {
    if (!isBrowserOperationPath(new URL(response.url()).pathname)) return;
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
    await expect(
      page.getByRole("complementary", { name: "Product inspector" }),
    ).toBeVisible({ timeout: 5000 });
  }).toPass({ timeout: 30000 });
  await page
    .getByRole("complementary", { name: "Product inspector" })
    .getByRole("button", { name: "Open full product details" })
    .click();
  await expect(page).toHaveURL(/\/products\/PRD-/u);
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
    expect(detailUrl.pathname).toContain("entity.detail");
    expect(detailUrl.search).toBe("");
    expect(request.input).toEqual(
      expect.objectContaining({
        entity: "product",
        shortcode: expect.any(String),
      }),
    );
  }

  // Inputs stay in the POST body; each URL names the operations it carries.
  for (const request of starts) {
    const names = new URL(request.url).pathname
      .split("/")
      .at(-1)
      ?.replace(/^batch~/u, "")
      .split(",");
    expect(names).toContain(request.operation);
  }

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

  // Response-owned ids, rather than a shared module-global "last id", make
  // each completed browser request independently searchable in traces.
  await Promise.all(requestIdReads);
  expect(requestIds.length).toBeGreaterThanOrEqual(3);
  for (const requestId of requestIds) expect(requestId).toBe(canaryRequestId);
});

test("server error references remain usable on desktop", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const responseBody = `Synthetic upstream refused\n${"diagnostic ".repeat(300)}\nSQLSTATE 53300 <script>synthetic-inert</script>`;
  const stack = `Error: synthetic upstream\n${" at synthetic-frame\n".repeat(300)}stack tail`;
  let structured = false;
  await page.goto("/");
  await page.route(`**${BROWSER_OPERATION_PATH}/*`, async (route) => {
    if (await unbatchFor(route, ["entity.list"])) return;
    if (route.request().headers()["x-cubby-operation"] !== "entity.list") {
      await route.continue();
      return;
    }
    await route.fulfill({
      status: 500,
      headers: {
        "content-type": structured ? "application/json" : "text/plain",
        "x-request-id": "diagnostic-test-request",
        "x-sentry-event-id": "0123456789abcdef0123456789abcdef",
      },
      body: structured
        ? JSON.stringify(
            superjson.serialize({
              ok: false,
              error: {
                code: "INTERNAL_SERVER_ERROR",
                message: "Synthetic structured server refusal",
                diagnostics: {
                  origin: "server",
                  operation: "entity.list",
                  stage: "run",
                  causes: [{ name: "Error", message: responseBody, stack }],
                },
              },
            }),
          )
        : responseBody,
    });
  });
  await page
    .getByLabel("Workspace navigation")
    .getByRole("link", { name: /^Products(?: [\d,]+ records)?$/ })
    .click();
  // Navigation can reuse prefetched core rows; a new filter exercises the
  // browser error boundary rather than depending on that cache's freshness.
  const search = page.getByRole("textbox", {
    name: "Search products or shortcode",
  });
  // SSR mounts both responsive toolbars. Strict actions resolve before their
  // enabled wait, so first require the route to expose one hydrated search.
  await expect(search).toHaveCount(1);
  await expect(search).toBeEnabled();
  await search.fill("Synthetic diagnostic filter");
  await expect(
    page.getByText(/HTTP 500.*Synthetic upstream refused/u).first(),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Details", exact: true })
    .first()
    .click();
  const dialog = page.getByRole("dialog", { name: "Technical details" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("entity.list / http");
  await expect(dialog).toContainText(
    "SQLSTATE 53300 <script>synthetic-inert</script>",
  );
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
  const copied = JSON.parse(
    await page.evaluate(() => navigator.clipboard.readText()),
  );
  expect(copied.requestId).toBe("diagnostic-test-request");
  expect(copied.diagnostics.http.body).toBe(responseBody);
  await expect(dialog.getByRole("button", { name: "Copied" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  structured = true;
  await search.fill("Synthetic structured diagnostic filter");
  await expect(
    page
      .getByText("Synthetic structured server refusal", { exact: true })
      .first(),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Details", exact: true })
    .first()
    .click();
  await expect(dialog).toContainText("stack tail");
  await expect(dialog.locator("script")).toHaveCount(0);
  await dialog.getByRole("button", { name: "Copy details" }).click();
  const withStack = JSON.parse(
    await page.evaluate(() => navigator.clipboard.readText()),
  );
  expect(withStack.diagnostics.causes[0]).toMatchObject({
    message: responseBody,
    stack,
  });
});

// The real browser must remain usable while an independent field read hangs;
// releasing a failed group must not replace its already visible base records.
