import type { Locator, Page } from "@playwright/test";

import { attachPurchaseProducts } from "~/server/repo/purchase-products";
import { resolveLiveShortcode } from "~/server/repo/shortcode-resolver";

import { taxonomyShortcode } from "../../tooling/product-category-fixtures";
import {
  seedProductCategoryPrerequisite,
  seedProductPrerequisite,
} from "./fixtures-catalog";
import {
  createEvidenceHarnessContext,
  createFixture,
  ensureMemberParty,
  seedConcurrently,
} from "./fixtures-core";
import { escapeRegExp, gotoAuthenticatedPage, uniqueName } from "./e2e-helpers";
import { expect, test } from "./e2e-test";

function recordRows(container: Page | Locator) {
  return container
    .getByRole("row")
    .or(
      container
        .getByRole("list", { name: /^(Products|Purchases) list$/ })
        .getByRole("listitem"),
    );
}

async function linkProducts(page: Page, purchase: string, products: string[]) {
  const { db, actor } = await createEvidenceHarnessContext(page);
  const purchaseId = await resolveLiveShortcode(db, purchase, "purchase");
  if (purchaseId === null) throw new Error("Synthetic purchase missing");
  const productIds = await Promise.all(
    products.map(async (code) => {
      const id = await resolveLiveShortcode(db, code, "product");
      if (id === null) throw new Error("Synthetic product missing");
      return id;
    }),
  );
  await attachPurchaseProducts(db, purchaseId, productIds, actor);
}

async function evidenceLine(
  page: Page,
  input: {
    name: string;
    productId: string;
    purchaseId: string;
    cost: number | null;
    productQuantity: number | null;
    date?: string;
    future?: boolean;
  },
) {
  return createFixture(page, "expense", {
    date: "2026-01-05",
    costType: "materials",
    trade: "other",
    lineKind: "principal",
    lineBasis: "item_line",
    ...input,
  });
}

test("purchase product roles survive deduplication, Open all, and inverse navigation", async ({
  page,
}, testInfo) => {
  const name = uniqueName(testInfo, "Synthetic relationship roles");
  const vendor = await createFixture(page, "vendor", {
    name: `${name} vendor`,
  });
  const purchase = await createFixture(page, "purchase", {
    vendorId: vendor.id,
    orderId: `${name} order`,
    date: "2026-01-05",
  });
  const mixed = await seedProductPrerequisite(page, { name: `${name} mixed` });
  const linked = await seedProductPrerequisite(page, {
    name: `${name} linked`,
  });
  const planned = await seedProductPrerequisite(page, {
    name: `${name} planned`,
  });
  const unknown = await seedProductPrerequisite(page, {
    name: `${name} unknown`,
  });
  const adjusted = await seedProductPrerequisite(page, {
    name: `${name} adjusted`,
  });
  for (const line of [
    { cost: 20, productQuantity: 1 },
    { cost: -5, productQuantity: 0 },
    { cost: -10, productQuantity: -1 },
    { cost: 0, productQuantity: -1 },
    { cost: 25, productQuantity: 1, future: true },
  ])
    await evidenceLine(page, {
      name: `${name} mixed line`,
      productId: mixed.id,
      purchaseId: purchase.id,
      ...line,
    });
  await evidenceLine(page, {
    name: `${name} planned line`,
    productId: planned.id,
    purchaseId: purchase.id,
    cost: 25,
    productQuantity: 1,
    future: true,
  });
  await evidenceLine(page, {
    name: `${name} unknown line`,
    productId: unknown.id,
    purchaseId: purchase.id,
    cost: null,
    productQuantity: null,
  });
  await evidenceLine(page, {
    name: `${name} adjustment line`,
    productId: adjusted.id,
    purchaseId: purchase.id,
    cost: -5,
    productQuantity: 0,
  });
  await linkProducts(page, purchase.id, [mixed.id, linked.id]);

  await gotoAuthenticatedPage(page, `/purchases/${purchase.id}`);
  const products = page.locator("#products");
  await expect(products.getByRole("heading", { level: 2 })).toHaveText(
    /Products\s*5/,
  );
  const mixedRow = recordRows(products).filter({ hasText: `${name} mixed` });
  for (const role of [
    "Acquired",
    "Exited",
    "Discarded",
    "Price adjusted",
    "Planned",
  ])
    await expect(mixedRow.getByText(role, { exact: true })).toBeVisible();
  await expect(
    recordRows(products)
      .filter({ hasText: `${name} linked` })
      .getByText("Linked", { exact: true }),
  ).toBeVisible();
  const plannedRow = recordRows(products).filter({
    hasText: `${name} planned`,
  });
  await expect(plannedRow.getByText("Planned", { exact: true })).toBeVisible();
  await expect(plannedRow.getByText("Acquired", { exact: true })).toHaveCount(
    0,
  );
  await expect(products.getByText("Sale", { exact: true })).toHaveCount(0);

  const openAll = products.getByLabel("Open all products", { exact: true });
  await openAll.evaluate((element) =>
    element.scrollIntoView({ block: "center" }),
  );
  await openAll.click();
  await expect(page).toHaveURL(/\/connections\?/);
  await expect(
    page.getByRole("columnheader", { name: "Movement", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("row")).toHaveCount(6);
  await expect(
    recordRows(page)
      .filter({ hasText: `${name} unknown` })
      .getByText("Unknown movement", { exact: true }),
  ).toBeVisible();
  const adjustmentRow = recordRows(page).filter({
    hasText: `${name} adjusted`,
  });
  await expect(
    adjustmentRow.getByText("Price adjusted", { exact: true }),
  ).toBeVisible();
  await expect(adjustmentRow.getByText("Exited", { exact: true })).toHaveCount(
    0,
  );
  await page.getByRole("link", { name: `${name} mixed`, exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/products/${mixed.id}`));
  const purchases = page.locator("#purchases");
  await expect(purchases.getByRole("heading", { level: 2 })).toHaveText(
    /Purchases\s*1/,
  );
  for (const role of [
    "Acquired",
    "Exited",
    "Discarded",
    "Price adjusted",
    "Planned",
  ])
    await expect(purchases.getByText(role, { exact: true })).toBeVisible();
});

test("phone relationship rows keep planned and explicit link evidence separate", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const name = uniqueName(testInfo, "Synthetic phone evidence");
  const vendor = await createFixture(page, "vendor", { name });
  const purchase = await createFixture(page, "purchase", {
    vendorId: vendor.id,
    orderId: `${name} order`,
    date: "2026-01-05",
  });
  const product = await seedProductPrerequisite(page, { name: `${name} item` });
  await evidenceLine(page, {
    name: `${name} future line`,
    productId: product.id,
    purchaseId: purchase.id,
    cost: 25,
    productQuantity: 1,
    future: true,
  });
  await linkProducts(page, purchase.id, [product.id]);
  await gotoAuthenticatedPage(page, `/purchases/${purchase.id}`);
  const products = page.locator("#products");
  await expect(products.getByText("Linked", { exact: true })).toBeVisible();
  await expect(products.getByText("Planned", { exact: true })).toBeVisible();
  await expect(products.getByText("Acquired", { exact: true })).toHaveCount(0);
  const openAll = products.getByLabel("Open all products", { exact: true });
  await openAll.evaluate((element) =>
    element.scrollIntoView({ block: "center" }),
  );
  await openAll.click();
  await expect(page).toHaveURL(/\/connections\?/);
  await expect(
    recordRows(page)
      .filter({ hasText: `${name} item` })
      .getByText("Linked", { exact: true }),
  ).toBeVisible();
  await expect(
    recordRows(page)
      .filter({ hasText: `${name} item` })
      .getByText("Planned", { exact: true }),
  ).toBeVisible();
});

for (const state of ["owned", "exited", "uncertain"] as const) {
  test(`Product overview guides ${state} ownership and keeps supporting details available`, async ({
    page,
  }, testInfo) => {
    const name = uniqueName(testInfo, `Synthetic ${state} overview`);
    await ensureMemberParty(page, name);
    const feature = state === "owned" ? "food" : "tools";
    const category = await seedProductCategoryPrerequisite(page, {
      name: `${name} category`,
      parentId: taxonomyShortcode(feature),
    });
    const product = await seedProductPrerequisite(page, {
      name,
      categoryId: category.id,
    });
    const vendor = await createFixture(page, "vendor", {
      name: `${name} vendor`,
    });
    const purchase = await createFixture(page, "purchase", {
      vendorId: vendor.id,
      orderId: `${name} order`,
      date: "2026-01-05",
    });
    if (state === "uncertain") {
      await linkProducts(page, purchase.id, [product.id]);
      await evidenceLine(page, {
        name: `${name} plan`,
        productId: product.id,
        purchaseId: purchase.id,
        cost: 25,
        productQuantity: 1,
        future: true,
      });
    } else {
      await evidenceLine(page, {
        name: `${name} acquisition`,
        productId: product.id,
        purchaseId: purchase.id,
        cost: 25,
        productQuantity: 1,
      });
      if (state === "exited") {
        const exitPurchase = await createFixture(page, "purchase", {
          vendorId: vendor.id,
          orderId: `${name} exit order`,
          date: "2026-01-06",
        });
        await evidenceLine(page, {
          name: `${name} exit`,
          productId: product.id,
          purchaseId: exitPurchase.id,
          cost: -15,
          productQuantity: -1,
          date: "2026-01-06",
        });
      }
    }

    await gotoAuthenticatedPage(page, `/products/${product.id}`);
    const ownership = page.locator("#ownership");
    await expect(
      ownership.getByRole("heading", {
        name: "Ownership & evidence",
        exact: true,
      }),
    ).toBeVisible();
    await expect(page.locator("#nutrition")).toHaveCount(0);
    await expect(page.locator("#runs")).toHaveCount(0);
    if (state === "exited") {
      await expect(
        ownership.getByText("Recorded ownership ended on 2026-01-06.", {
          exact: true,
        }),
      ).toBeVisible();
      await expect(
        ownership.getByText("Add an item photo", { exact: true }),
      ).toHaveCount(0);
      await expect(
        ownership.getByText("Record where it lives", { exact: true }),
      ).toHaveCount(0);
    } else if (state === "owned") {
      await expect(
        ownership.getByText("Recorded movements establish ownership.", {
          exact: true,
        }),
      ).toBeVisible();
      await expect(
        ownership.getByText("Record where it lives", { exact: true }),
      ).toBeVisible();
    } else {
      await expect(
        ownership.getByText(
          "Ownership is uncertain: recorded movements do not establish the current quantity.",
          { exact: true },
        ),
      ).toBeVisible();
      await expect(
        ownership.getByText(
          "Confirm whether you still own it before recording stock",
          { exact: true },
        ),
      ).toBeVisible();
      await expect(
        page.locator("#movements").getByText("Acquired", { exact: true }),
      ).toHaveCount(0);
    }
    await page
      .getByRole("button", { name: "More details", exact: true })
      .click();
    await page
      .getByRole("menuitem", {
        name: feature === "food" ? "Nutrition" : "Unit mappings",
        exact: true,
      })
      .click();
    if (feature === "food") {
      await expect(
        page.getByText(
          "No nutrition on file — link a USDA food or enter the package label.",
          { exact: true },
        ),
      ).toBeVisible();
    } else {
      const mappings = page.locator("#unit-mappings");
      await expect(
        mappings.getByRole("heading", { name: "Unit mappings", exact: true }),
      ).toBeVisible();
      if (state === "exited")
        await expect(
          mappings.getByRole("button", {
            name: "Conversion graph",
            exact: true,
          }),
        ).toBeVisible();
    }
    await page.getByRole("tab", { name: "Overview", exact: true }).click();
    await page
      .getByRole("button", { name: "More details", exact: true })
      .click();
    await page
      .getByRole("menuitem", { name: "Enrichment history", exact: true })
      .click();
    await expect(
      page.getByText("No targeted enrichment runs have been recorded.", {
        exact: true,
      }),
    ).toBeVisible();
  });
}

test("Similar products shows the first twelve tag matches and expands the rest", async ({
  page,
}, testInfo) => {
  const name = uniqueName(testInfo, "Synthetic similarity");
  const tags = [name.replaceAll(" ", "-").toLowerCase()];
  const source = await seedProductPrerequisite(page, {
    name: `${name} source`,
    tags,
  });
  const candidates = Array.from({ length: 14 }, (_, index) => ({
    name: `${name} candidate ${String(index + 1).padStart(2, "0")}`,
    tags,
  }));
  await seedConcurrently(candidates, (candidate) =>
    seedProductPrerequisite(page, candidate),
  );
  await gotoAuthenticatedPage(page, `/products/${source.id}`);
  await expect(page.locator("#fits-with")).toHaveCount(0);
  await page.getByRole("button", { name: "More details", exact: true }).click();
  await page
    .getByRole("menuitem", { name: "Similar products", exact: true })
    .click();
  const similar = page.locator("#fits-with");
  const links = similar.getByRole("link", {
    name: new RegExp(`^${escapeRegExp(name)} candidate`),
  });
  await expect(links).toHaveCount(12);
  await expect(
    similar.getByText(`Shared tag: ${tags[0]}`, { exact: true }),
  ).toHaveCount(12);
  await similar
    .getByRole("button", { name: "Show 2 more products", exact: true })
    .click();
  await expect(links).toHaveCount(14);
  for (const candidate of candidates)
    await expect(
      similar.getByRole("link", { name: candidate.name, exact: true }),
    ).toBeVisible();
  await expect(
    similar.getByRole("button", { name: "Show 2 more products", exact: true }),
  ).toHaveCount(0);
});

// Regression: a root feature binding read "Override on this product category"
// with "Nothing to inherit", and no category showed its feature ancestry.
test("feature explanation ladders ancestry and calls a root binding set here", async ({
  page,
}, testInfo) => {
  const name = uniqueName(testInfo, "Synthetic feature ladder");
  const child = await seedProductCategoryPrerequisite(page, {
    name: `${name} child`,
    parentId: taxonomyShortcode("household"),
  });
  // The record's own field, not a Subcategories row's rail button.
  const explanation = page.locator(
    'button[aria-label="How feature is determined"]:not(table button)',
  );

  await gotoAuthenticatedPage(
    page,
    `/product-categories/${child.id}`,
    explanation,
  );
  await explanation.click();
  const popover = page.locator("[data-slot=popover-content]");
  await expect(popover.getByText("Inherited", { exact: true })).toBeVisible();
  await expect(
    popover.getByText("Resolution order", { exact: true }),
  ).toBeVisible();
  const rows = popover.locator("li[data-role]");
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toHaveAttribute("data-role", "unset");
  await expect(rows.last()).toHaveAttribute("data-role", "wins");
  await expect(popover.getByText(/override/i)).toHaveCount(0);
  await page.keyboard.press("Escape");

  await gotoAuthenticatedPage(
    page,
    `/product-categories/${taxonomyShortcode("household")}`,
    explanation,
  );
  await explanation.click();
  await expect(popover.getByText("Set here", { exact: true })).toBeVisible();
  await expect(popover.getByText(/override|inherit/i)).toHaveCount(0);
  await expect(
    popover.getByRole("button", { name: /Use inherited value|Clear value/ }),
  ).toHaveCount(0);
});
