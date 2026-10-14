import type { Locator } from "@playwright/test";

import { BROWSER_OPERATION_PATH } from "~/lib/browser-operation-path";

import { dispatchesOperation, unbatchFor } from "./dispatch-wire";
import { gotoAuthenticatedPage } from "./e2e-helpers";
import { expect, test } from "./e2e-test";
import { createFixture } from "./fixtures-core";
import { seedActiveResearchHistory } from "./fixtures-photos";

// The server nests a tree list: the browser shows the roots it pages and reads
// an expanded row's children, never nesting loaded pages itself.
test("Runs open flat and nest from the server on request", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const sample = await seedActiveResearchHistory(
    page,
    `Nesting vendor ${Date.now()}`,
  );
  await gotoAuthenticatedPage(page, `/runs?vendorId=${sample.vendorId}`);
  const rows = page
    .getByRole("table")
    .getByRole("row")
    .filter({ hasText: sample.name });
  await expect(rows).toHaveCount(2);

  await page.getByRole("button", { name: "Actions", exact: true }).click();
  await page.getByRole("menuitem", { name: "Show nested list" }).click();
  await expect(page).toHaveURL(/[?&]nest=on/);
  await expect(rows).toHaveCount(1);
  await expect(rows.getByLabel("1 nested")).toBeVisible();

  await rows.getByRole("button", { name: "Expand" }).click();
  await expect(rows).toHaveCount(2);

  await page.reload();
  await expect(page).toHaveURL(/[?&]nest=on/);
  await expect(rows).toHaveCount(1);
  await expect(rows.getByLabel("1 nested")).toBeVisible();
});

// A phone has no inline Nested button: the Filter sheet carries the same
// switch, driving the same `nest` URL key and declared default.
test("a phone toggles Runs nested from the Filter sheet", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const sample = await seedActiveResearchHistory(
    page,
    `Nesting phone ${Date.now()}`,
  );
  await gotoAuthenticatedPage(page, `/runs?vendorId=${sample.vendorId}`);
  const cards = page.getByRole("listitem").filter({ hasText: sample.name });
  await expect(cards).toHaveCount(2);

  await page.getByRole("button", { name: /^Filter(?: \d+)?$/ }).click();
  const nested = page.getByRole("switch", { name: "Nested" });
  await expect(nested).toHaveAttribute("aria-checked", "false");
  await nested.click();
  await expect(page).toHaveURL(/[?&]nest=on/);
  await expect(nested).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Escape");
  await expect(cards).toHaveCount(1);
  await cards.getByRole("button", { name: "Expand" }).click();
  await expect(cards).toHaveCount(2);

  await page.reload();
  await expect(page).toHaveURL(/[?&]nest=on/);
  await expect(cards).toHaveCount(1);
});

test("a category list renders nested from the server", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const prefix = `Nesting shelf ${Date.now()}`;
  const parent = await createFixture(page, "productCategory", {
    name: `${prefix} pantry`,
  });
  await createFixture(page, "productCategory", {
    name: `${prefix} spices`,
    parentId: parent.id,
  });
  await gotoAuthenticatedPage(
    page,
    `/product-categories?q=${encodeURIComponent(prefix)}`,
  );
  const rows = page
    .getByRole("table")
    .getByRole("row")
    .filter({ hasText: prefix });
  await expect(rows).toHaveCount(1);
  await expect(rows).toContainText(`${prefix} pantry`);
  await rows.getByRole("button", { name: "Expand" }).click();
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(1)).toContainText(`${prefix} spices`);
});

// An expanded parent reads one children page at a time: a failed read shows
// its error with Retry instead of an empty subtree, and a parent with more
// matching children than a page offers Load more instead of paging silently.
test("an expanded category retries a failed read and loads more children", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const prefix = `Nesting aisle ${Date.now()}`;
  const parent = await createFixture(page, "productCategory", {
    name: `${prefix} pantry`,
  });
  for (const leaf of ["grains", "spices"])
    await createFixture(page, "productCategory", {
      name: `${prefix} ${leaf}`,
      parentId: parent.id,
    });
  let failChildren = true;
  await page.route(`**${BROWSER_OPERATION_PATH}`, async (route) => {
    if (await unbatchFor(route, ["entity.listBase"])) return;
    const childrenRead = dispatchesOperation(
      route.request(),
      "entity.listBase",
      (item) => JSON.stringify(item.input).includes('"children"'),
    );
    if (!childrenRead) {
      await route.continue();
      return;
    }
    if (!failChildren) {
      // A list page holds 100 rows; one-row children pages let two children
      // span two pages without seeding a hundred.
      await route.continue({
        postData: (route.request().postData() ?? "").replace(
          /"pageSize":\d+/,
          '"pageSize":1',
        ),
      });
      return;
    }
    await route.fulfill({
      status: 500,
      headers: { "content-type": "text/plain" },
      body: "Internal Server Error",
    });
  });
  await gotoAuthenticatedPage(
    page,
    `/product-categories?q=${encodeURIComponent(prefix)}`,
  );
  const table = page.getByRole("table");
  const rows = table.getByRole("row").filter({ hasText: prefix });
  await expect(rows).toHaveCount(1);

  await rows.getByRole("button", { name: "Expand" }).click();
  const failure = table
    .getByRole("alert")
    .filter({ hasText: "Couldn't load nested rows." });
  await expect(failure).toBeVisible();
  await expect(rows).toHaveCount(1);

  failChildren = false;
  await failure.getByRole("button", { name: "Retry" }).click();
  await expect(failure).toHaveCount(0);
  await expect(rows).toHaveCount(2);
  const loadMore = table.getByRole("button", { name: "Load more" });
  await expect(table.getByText("1 more", { exact: true })).toBeVisible();

  await loadMore.click();
  await expect(rows).toHaveCount(3);
  await expect(loadMore).toHaveCount(0);
});

/** A tree chart node's distance from the root, from its laid-out position. */
const treeDepthOffset = (node: Locator) =>
  node.evaluate((element) => {
    const transform = element
      .closest("g[transform]")
      ?.getAttribute("transform");
    return Number(/translate\(([-\d.]+)/.exec(transform ?? "")?.[1]);
  });

// The hierarchy chart draws the server's nesting: a child sits one level
// below its parent, and the parent at the same level as another root.
test("the category hierarchy chart nests categories as the server does", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const prefix = `Nesting chart ${Date.now()}`;
  const parent = await createFixture(page, "productCategory", {
    name: `${prefix} pantry`,
  });
  const spices = await createFixture(page, "productCategory", {
    name: `${prefix} spices`,
    parentId: parent.id,
  });
  const garage = await createFixture(page, "productCategory", {
    name: `${prefix} garage`,
  });
  // The chart draws categories that hold products.
  for (const category of [spices, garage])
    await createFixture(page, "product", {
      name: `${prefix} item ${category.id}`,
      categoryId: category.id,
    });
  await gotoAuthenticatedPage(page, "/product-categories?view=hierarchy");

  const node = (name: string) =>
    page.getByRole("link", { name: `${prefix} ${name}`, exact: true }).first();
  await expect(node("spices")).toBeAttached();
  const [pantryDepth, spicesDepth, garageDepth] = await Promise.all(
    ["pantry", "spices", "garage"].map((name) => treeDepthOffset(node(name))),
  );
  expect(pantryDepth).toBe(garageDepth);
  expect(spicesDepth).toBeGreaterThan(pantryDepth ?? Number.POSITIVE_INFINITY);
});
