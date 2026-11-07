import { fieldEnvelope } from "@cubby/schemas/field-envelope";
import { entityApi } from "./support/entity-api";
import { z } from "zod";
import {
  chooseOption,
  gotoAuthenticatedPage,
  selectComboboxItem,
} from "./support/e2e-helpers";
import { expect, test } from "./support/e2e-test";
import { createFixtureGraph } from "./fixtures/core";

// The browser owns hierarchy search, actual-allocation inspection, reviewed
// apply/reset and stale-preview feedback. Refund arithmetic and topology
// enforcement stay in the review integration owners.
test("reviews historical item classification and preserves explicit purpose", async ({
  page,
  baseURL,
}, testInfo) => {
  const headers = { Origin: baseURL! };
  const categoryName = "Synthetic classification clothing";
  const parentName = "Synthetic classification items";
  const childName = "Synthetic classification shoes";
  const siblingName = "Synthetic classification bags";
  const giftsName = "Synthetic classification gifts";
  const purposeRootName = "Synthetic classification purpose root";
  const { clothing, gifts, originalSpending, expense, explicitExpense } =
    await createFixtureGraph(page, async (create) => {
      const { id: purposeRoot } = await create("spendingCategory", {
        name: purposeRootName,
      });
      const { id: clothing } = await create("spendingCategory", {
        name: categoryName,
        parentId: purposeRoot,
      });
      const { id: gifts } = await create("spendingCategory", {
        name: giftsName,
      });
      const { id: originalSpending } = await create("spendingCategory", {
        name: "Synthetic classification original spending",
      });
      const { id: parent } = await create("productCategory", {
        name: parentName,
        spendingCategoryMode: "mapped",
        spendingCategoryId: originalSpending,
      });
      const { id: productCategory } = await create("productCategory", {
        name: childName,
        parentId: parent,
      });
      await create("productCategory", {
        name: siblingName,
        parentId: parent,
      });
      const { id: vendor } = await create("vendor", {
        name: "Synthetic classification mixed shop",
        spendingProfile: "mixed_retail",
      });
      const { id: product } = await create("product", {
        name: "Synthetic classification boots",
        brandId: vendor,
        categoryId: productCategory,
      });
      const { id: purchase } = await create("purchase", {
        vendorId: vendor,
        date: "2026-09-01",
      });
      const { id: expense } = await create("expense", {
        name: "Synthetic classification boots",
        cost: 60,
        date: "2026-09-01",
        costType: "materials",
        trade: "other",
        productId: product,
        purchaseId: purchase,
      });
      const { id: explicitExpense } = await create("expense", {
        name: "Synthetic classification gift boots",
        cost: 25,
        date: "2026-09-01",
        costType: "materials",
        trade: "other",
        productId: product,
        purchaseId: purchase,
        spendingCategoryId: gifts,
      });
      await create("expense", {
        name: "Synthetic classification productless gift",
        cost: 7,
        date: "2026-09-01",
        costType: "materials",
        trade: "other",
        purchaseId: purchase,
        spendingCategoryId: gifts,
      });
      return { clothing, gifts, originalSpending, expense, explicitExpense };
    });

  const patch = async (
    id: string,
    data: z.infer<ReturnType<typeof z.json>>,
  ) => {
    const response = await entityApi(page.request).update("expense", id, data, {
      headers,
    });
    expect(response.ok(), await response.text()).toBeTruthy();
  };
  const read = async (id = expense) => {
    const response = await entityApi(page.request).get("expense", id, {});
    expect(response.ok(), await response.text()).toBeTruthy();
    return z
      .object({
        cost: z.number(),
        fields: z.object({
          spendingCategoryId: fieldEnvelope(z.string().nullable(), z.string()),
        }),
      })
      .parse(await response.json());
  };
  await gotoAuthenticatedPage(
    page,
    "/product-categories?view=hierarchy",
    page.getByRole("table", { name: "Product Categories table", exact: true }),
  );
  const tree = page.getByRole("table", {
    name: "Product Categories table",
    exact: true,
  });
  await expect(
    page.getByRole("button", { name: "Flat", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("textbox", { name: /Search/ })
    .fill("classification shoes");
  const parent = tree.getByRole("row").filter({
    has: page.getByRole("button", {
      name: "Collapse",
      exact: true,
    }),
  });
  await expect(
    parent.getByRole("link", { name: parentName, exact: true }),
  ).toBeVisible();
  await expect(
    tree.getByRole("link", { name: childName, exact: true }),
  ).toBeVisible();
  await expect(parent.getByText("Ancestor", { exact: true })).toBeInViewport({
    ratio: 1,
  });
  await expect(
    tree.getByRole("link", { name: siblingName, exact: true }),
  ).toHaveCount(0);
  await expect(
    tree.getByRole("columnheader", { name: /Spending/ }),
  ).toBeVisible();
  const child = tree
    .getByRole("row")
    .filter({ has: page.getByRole("link", { name: childName, exact: true }) });
  await expect(
    parent.getByRole("checkbox", { name: "Select row", exact: true }),
  ).toHaveCount(0);
  await expect(
    child.getByRole("button", { name: "Expand", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Flat", exact: true }).click();
  await expect(tree.getByRole("row")).toHaveCount(2);
  await expect(page.getByRole("textbox", { name: /Search/ })).toHaveValue(
    "classification shoes",
  );
  await page.getByRole("button", { name: "Tree", exact: true }).click();
  await expect(parent).toBeVisible();
  await child.getByRole("link", { name: childName, exact: true }).click();
  const allocations = page.getByRole("region", {
    name: "Where this branch's money lands",
    exact: true,
  });
  await expect(
    allocations.getByRole("link", { name: "$60.00", exact: true }),
  ).toBeVisible();
  await expect(
    allocations.getByRole("row").filter({ hasText: giftsName }),
  ).toContainText("$25.00");
  await allocations
    .getByRole("button", { name: giftsName, exact: true })
    .click();
  await expect(
    page
      .getByRole("region", {
        name: `Contributing branches · ${giftsName}`,
        exact: true,
      })
      .getByRole("row")
      .filter({ hasText: childName }),
  ).toContainText("$25.00");
  await expect(
    page.getByRole("combobox", { name: "Parent category", exact: true }),
  ).toBeVisible();

  const viewport = page.viewportSize();
  const desktopPath = ".impeccable/review/category-mapping-desktop.png";
  await page.screenshot({ path: desktopPath, fullPage: true });
  await testInfo.attach("Category mapping desktop", {
    path: desktopPath,
    contentType: "image/png",
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    page.getByRole("dialog").filter({
      has: page.getByRole("heading", { name: childName, exact: true }),
    }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Close panel", exact: true }).click();
  await expect(
    page.getByRole("dialog").filter({
      has: page.getByRole("heading", { name: childName, exact: true }),
    }),
  ).toHaveCount(0);
  const mobileChild = page
    .getByRole("list", { name: "Product Categories list", exact: true })
    .getByRole("button", { name: new RegExp(`^${childName} `) });
  await expect(mobileChild).toBeVisible();
  const phoneTreePath = ".impeccable/review/category-mapping-mobile-tree.png";
  await page.screenshot({ path: phoneTreePath, fullPage: true });
  await testInfo.attach("Category mapping phone tree", {
    path: phoneTreePath,
    contentType: "image/png",
  });
  await mobileChild.press("Enter");
  await expect(
    page.getByRole("dialog").filter({
      has: page.getByRole("heading", { name: childName, exact: true }),
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Close panel", exact: true }),
  ).toBeVisible();
  const configuredMapping = page.getByRole("region", {
    name: "Configured mapping",
    exact: true,
  });
  await expect(
    configuredMapping.getByText(`Inherited from ${parentName}`, {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    configuredMapping
      .getByRole("term")
      .filter({ hasText: "Products in this branch" }),
  ).toBeVisible();
  await expect(
    configuredMapping.getByRole("definition").filter({ hasText: /^1$/ }),
  ).toBeVisible();
  const phonePath = ".impeccable/review/category-mapping-mobile.png";
  await page.screenshot({ path: phonePath, fullPage: true });
  await testInfo.attach("Category mapping phone", {
    path: phonePath,
    contentType: "image/png",
  });
  if (viewport) await page.setViewportSize(viewport);
  // A child with an inherited mapping must preview its stored inherit intent,
  // rather than sending the effective category as an explicit saved value.
  await page.getByRole("button", { name: "Preview historical impact" }).click();
  await expect(
    page.getByRole("button", { name: "Apply reviewed change" }),
  ).toBeVisible();
  await chooseOption(
    page,
    page.getByRole("combobox", {
      name: "Product category mapping",
      exact: true,
    }),
    "Map to spending category",
  );
  await selectComboboxItem(
    page,
    page.getByRole("combobox", { name: "Spending category", exact: true }),
    categoryName,
  );
  await page.getByRole("button", { name: "Preview historical impact" }).click();
  await expect(
    page.getByRole("button", { name: "Apply reviewed change" }),
  ).toBeVisible();
  expect((await read()).fields.spendingCategoryId).toMatchObject({
    current: { assignment: { kind: "inherit" } },
    result: {
      decision: { outcome: { kind: "value", value: originalSpending } },
    },
  });
  await patch(expense, { cost: 61 });
  await page.getByRole("button", { name: "Apply reviewed change" }).click();
  await expect(
    page.getByText(/changed after preview; review a fresh preview/).first(),
  ).toBeVisible();
  expect((await read()).fields.spendingCategoryId).toMatchObject({
    current: { assignment: { kind: "inherit" } },
    result: {
      decision: { outcome: { kind: "value", value: originalSpending } },
    },
  });
  await page.getByRole("button", { name: "Preview historical impact" }).click();
  await expect(
    page.getByRole("button", { name: "Apply reviewed change" }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Apply reviewed change" }).click();
  await expect(
    page.getByRole("button", { name: "Applied", exact: true }),
  ).toBeVisible();
  expect(await read()).toMatchObject({
    cost: 61,
    fields: {
      spendingCategoryId: {
        current: { assignment: { kind: "inherit" } },
        result: { decision: { outcome: { kind: "value", value: clothing } } },
      },
    },
  });
  expect(await read(explicitExpense)).toMatchObject({
    cost: 25,
    fields: {
      spendingCategoryId: {
        current: { assignment: { kind: "value", value: gifts } },
        result: { decision: { outcome: { kind: "value", value: gifts } } },
      },
    },
  });
  await patch(expense, { spendingCategoryId: gifts });
  expect(await read()).toMatchObject({
    fields: {
      spendingCategoryId: {
        current: { assignment: { kind: "value", value: gifts } },
        result: {
          decision: {
            outcome: { kind: "value", value: gifts },
            provenance: { kind: "own" },
          },
        },
      },
    },
  });
  await gotoAuthenticatedPage(
    page,
    `/expenses/${explicitExpense}`,
    page.getByRole("button", { name: "Use item detail", exact: true }),
  );
  await page
    .getByRole("button", { name: "Use item detail", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Preview historical impact", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Apply reviewed change", exact: true }),
  ).toBeVisible();
  expect(await read(explicitExpense)).toMatchObject({
    cost: 25,
    fields: {
      spendingCategoryId: {
        current: { assignment: { kind: "value", value: gifts } },
      },
    },
  });
  await page
    .getByRole("button", { name: "Apply reviewed change", exact: true })
    .click();
  await expect
    .poll(async () => read(explicitExpense))
    .toMatchObject({
      cost: 25,
      fields: {
        spendingCategoryId: {
          current: { assignment: { kind: "inherit" } },
          result: { decision: { outcome: { kind: "value", value: clothing } } },
        },
      },
    });
  expect(await read()).toMatchObject({
    cost: 61,
    fields: {
      spendingCategoryId: {
        current: { assignment: { kind: "value", value: gifts } },
      },
    },
  });
  await gotoAuthenticatedPage(
    page,
    "/spending-categories",
    page.getByRole("table", { name: "Spending Categories table", exact: true }),
  );
  const spendingTree = page.getByRole("table", {
    name: "Spending Categories table",
    exact: true,
  });
  const roots = await spendingTree.getByRole("link").allTextContents();
  expect(roots.indexOf(giftsName)).toBeLessThan(roots.indexOf(purposeRootName));
  await page
    .getByRole("textbox", { name: /Search/ })
    .fill("classification clothing");
  const spendingRoot = spendingTree.getByRole("row").filter({
    has: page.getByRole("link", { name: purposeRootName, exact: true }),
  });
  await expect(spendingRoot).toContainText("$25.00");
  const clothingRow = spendingTree.getByRole("row").filter({
    has: page.getByRole("link", { name: categoryName, exact: true }),
  });
  await expect(clothingRow).toContainText("$25.00");
  await clothingRow
    .getByRole("link", { name: categoryName, exact: true })
    .click();
  await expect(
    page
      .getByRole("region", {
        name: `Contributing branches · ${categoryName}`,
        exact: true,
      })
      .getByRole("row")
      .filter({ hasText: childName }),
  ).toContainText("$25.00");
  await expect(
    page.getByRole("region", {
      name: "Configured incoming mappings",
      exact: true,
    }),
  ).toContainText(childName);
  await expect(
    page.getByRole("region", { name: "Category and policies", exact: true }),
  ).toContainText("Itemization");
  const spendingDesktopPath =
    ".impeccable/review/spending-category-desktop.png";
  await page.screenshot({ path: spendingDesktopPath, fullPage: true });
  await testInfo.attach("Spending category desktop", {
    path: spendingDesktopPath,
    contentType: "image/png",
  });
  await page.getByRole("button", { name: "Close panel", exact: true }).click();
  await page
    .getByRole("textbox", { name: /Search/ })
    .fill("classification gifts");
  const giftsRow = spendingTree
    .getByRole("row")
    .filter({ has: page.getByRole("link", { name: giftsName, exact: true }) });
  await expect(giftsRow).toContainText("$68.00");
  await giftsRow.getByRole("link", { name: giftsName, exact: true }).click();
  const giftContributions = page.getByRole("region", {
    name: `Contributing branches · ${giftsName}`,
    exact: true,
  });
  await expect(giftContributions).toContainText("$61.00");
  await expect(giftContributions).toContainText("$7.00");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    page.getByRole("dialog").filter({
      has: page.getByRole("heading", { name: giftsName, exact: true }),
    }),
  ).toBeVisible();
  const spendingPhonePath = ".impeccable/review/spending-category-mobile.png";
  await page.screenshot({ path: spendingPhonePath, fullPage: true });
  await testInfo.attach("Spending category phone", {
    path: spendingPhonePath,
    contentType: "image/png",
  });
});
