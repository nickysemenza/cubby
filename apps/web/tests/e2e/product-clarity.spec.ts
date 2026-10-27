import type { Locator, Page } from "@playwright/test";

import { attachPurchaseProducts } from "~/server/domains/purchase/repo/purchase-products";
import { resolveLiveShortcode } from "~/server/generic/shortcode/repo/shortcode-resolver";

import { taxonomyShortcode } from "../../tooling/product-category-fixtures";
import {
  seedProductCategoryPrerequisite,
  seedProductPrerequisite,
} from "./fixtures/catalog";
import {
  createEvidenceHarnessContext,
  createFixture,
  createFixtureGraph,
  ensureMemberParty,
  seedConcurrently,
} from "./fixtures/core";
import {
  inlineExplanation,
  escapeRegExp,
  gotoAuthenticatedPage,
  uniqueName,
} from "./support/e2e-helpers";
import { expect, test } from "./support/e2e-test";

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

test("phone relationship rows keep planned and explicit link evidence separate", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const name = uniqueName(testInfo, "Synthetic phone evidence");
  const { purchase, product } = await createFixtureGraph(
    page,
    async (create) => {
      const vendor = await create("vendor", { name });
      const purchase = await create("purchase", {
        vendorId: vendor.id,
        orderId: `${name} order`,
        date: "2026-01-05",
      });
      const brand = await create("vendor", { name: `${name} brand` });
      const product = await create("product", {
        name: `${name} item`,
        brandId: brand.id,
      });
      await create("expense", {
        date: "2026-01-05",
        costType: "materials",
        trade: "other",
        lineKind: "principal",
        lineBasis: "item_line",
        name: `${name} future line`,
        productId: product.id,
        purchaseId: purchase.id,
        cost: 25,
        productQuantity: 1,
        future: true,
      });
      return { purchase, product };
    },
  );
  await linkProducts(page, purchase.id, [product.id]);
  await gotoAuthenticatedPage(page, `/purchases/${purchase.id}#work`);
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
    const { product, purchase } = await createFixtureGraph(
      page,
      async (create) => {
        const category = await create("productCategory", {
          name: `${name} category`,
          parentId: taxonomyShortcode(feature),
          sortOrder: 0,
          feature: null,
        });
        const brand = await create("vendor", { name: `${name} brand` });
        const product = await create("product", {
          name,
          categoryId: category.id,
          brandId: brand.id,
        });
        const vendor = await create("vendor", { name: `${name} vendor` });
        const purchase = await create("purchase", {
          vendorId: vendor.id,
          orderId: `${name} order`,
          date: "2026-01-05",
        });
        if (state !== "uncertain") {
          await create("expense", {
            name: `${name} acquisition`,
            productId: product.id,
            purchaseId: purchase.id,
            cost: 25,
            productQuantity: 1,
            date: "2026-01-05",
            costType: "materials",
            trade: "other",
            lineKind: "principal",
            lineBasis: "item_line",
          });
          if (state === "exited") {
            const exitPurchase = await create("purchase", {
              vendorId: vendor.id,
              orderId: `${name} exit order`,
              date: "2026-01-06",
            });
            await create("expense", {
              name: `${name} exit`,
              productId: product.id,
              purchaseId: exitPurchase.id,
              cost: -15,
              productQuantity: -1,
              date: "2026-01-06",
              costType: "materials",
              trade: "other",
              lineKind: "principal",
              lineBasis: "item_line",
            });
          }
        }
        return { product, purchase };
      },
    );
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
    }

    await gotoAuthenticatedPage(page, `/products/${product.id}`);
    const ownership = page.locator("#ownership");
    await expect(
      ownership.getByRole("heading", {
        name: "Ownership & evidence",
        exact: true,
      }),
    ).toBeVisible();
    await expect(page.locator("#nutrition")).toBeVisible();
    await expect(page.locator("#runs")).toBeVisible();
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
      .getByRole("heading", {
        name: feature === "food" ? "Nutrition" : "Unit mappings",
        exact: true,
      })
      .scrollIntoViewIfNeeded();
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
  const similar = page.locator("#fits-with");
  await expect(similar).toBeVisible();
  await similar
    .getByRole("heading", { name: "Similar products", exact: true })
    .scrollIntoViewIfNeeded();
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
test("feature explanation ladders ancestry and identifies the deciding root binding", async ({
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
  let popover = await inlineExplanation(page, explanation);
  await expect(
    popover.getByRole("heading", { name: "Effective result", exact: true }),
  ).toBeVisible();
  // The chain reads nearest source first: this category unset, its parent used.
  await expect(
    popover.getByRole("list", { name: "Resolution order", exact: true }),
  ).toBeVisible();
  await expect(
    popover.getByText("This product category", { exact: true }),
  ).toBeVisible();
  await expect(
    popover
      .getByRole("list", { name: "Resolution order", exact: true })
      .locator(
        `a[href="/product-categories/${taxonomyShortcode("household")}"]`,
      ),
  ).toBeVisible();
  await expect(popover.getByText("Not set", { exact: true })).toBeVisible();
  await expect(popover.getByText("Used", { exact: true })).toBeVisible();
  await expect(
    popover
      .getByRole("list", { name: "Resolution order", exact: true })
      .locator(":scope > li")
      .filter({
        has: page.locator(
          `a[href="/product-categories/${taxonomyShortcode("household")}"]`,
        ),
      }),
  ).toContainText("deciding");
  await expect(popover.getByText(/override/i)).toHaveCount(0);
  await page.keyboard.press("Escape");

  await gotoAuthenticatedPage(
    page,
    `/product-categories/${taxonomyShortcode("household")}`,
    explanation,
  );
  await explanation.click();
  popover = await inlineExplanation(page, explanation);
  const ownSource = popover
    .getByRole("list", { name: "Resolution order", exact: true })
    .locator(":scope > li")
    .filter({ hasText: "This product category" });
  await expect(ownSource).toContainText("Used");
  await expect(ownSource).toContainText("deciding");
  await expect(
    popover.getByRole("button", { name: /Use inherited|Clear value/ }),
  ).toHaveCount(0);
});
