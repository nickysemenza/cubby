/**
 * The core entity browser runtime is tRPC-free (docs/entities.md, "Transports").
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

type StartRequest = { payload: string; operationId?: string };

/**
 * Start sends a query operation's input in the URL and a mutation's in the
 * body, both in its structured wire encoding — object keys land in a `k` array
 * and values as `{"t":…,"s":…}`, so the input is matched by that shape rather
 * than by plain `"entity":"product"` JSON.
 */
const payloadOf = (url: string, body: string): string =>
  `${decodeURIComponent(url)}${body}`.replace(/[\\\s]/gu, "");

/** Procedures a core-entity read or write would land on if it regressed to tRPC. */
const CORE_ENTITY_PROCEDURES = [
  "product.list",
  "product.all",
  "product.byShortcode",
  "product.byId",
  "product.create",
  "product.update",
  "product.delete",
];

test("core entity list, detail, and mutation ride named Start operations", async ({
  page,
}) => {
  const starts: StartRequest[] = [];
  const trpcUrls: string[] = [];
  page.on("request", (request) => {
    const url = request.url();
    if (url.includes("/api/trpc")) {
      trpcUrls.push(url);
      return;
    }
    if (!url.includes("/_serverFn/")) return;
    starts.push({
      payload: payloadOf(url, request.postData() ?? ""),
      operationId: request.headers()["x-cubby-operation-id"],
    });
  });

  const name = `E2E Start Transport ${Date.now()}`;
  await createProduct(page, name);

  // In-app navigation throughout: a `page.goto` runs the route loader on the
  // server, where no browser request is issued and nothing is observable.
  await page.getByRole("link", { name: "Products", exact: true }).click();
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
  expect(
    matching('["entity","shortcode"]', '"s":"product"'),
    `entity.detail should carry the product shortcode:\n${report()}`,
  ).not.toHaveLength(0);

  // Every operation is correlatable end to end: the browser stamps the id the
  // server reads back off `x-cubby-operation-id`, and no two calls share one.
  const ids = starts
    .map((start) => start.operationId)
    .filter((id): id is string => id !== undefined);
  expect(ids.length).toBeGreaterThanOrEqual(3);
  for (const id of ids) expect(id).toMatch(/^op-\d+$/u);
  expect(new Set(ids).size).toBe(ids.length);

  const trpc = trpcUrls.join("\n");
  for (const procedure of CORE_ENTITY_PROCEDURES) {
    expect(trpc, `${procedure} must not be called`).not.toContain(procedure);
  }
});
