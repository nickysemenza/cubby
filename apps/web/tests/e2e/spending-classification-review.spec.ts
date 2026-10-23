import { entityApi } from "./support/entity-api";
import { z } from "zod";
import {
  chooseOption,
  gotoAuthenticatedPage,
  selectComboboxItem,
} from "./support/e2e-helpers";
import { expect, test } from "./support/e2e-test";
import { createFixtureGraph } from "./fixtures/core";

// The browser owns reviewed apply and visible stale-preview feedback. Taxonomy
// reassignment, reset, refunds and exact money stay in spending-classification-
// review.integration.test.ts and spending-classification-review-equivalence.integration.test.ts.
test("reviews historical item classification and preserves explicit purpose", async ({
  page,
  baseURL,
}) => {
  const headers = { Origin: baseURL! };
  const categoryName = "Synthetic classification clothing";
  const { clothing, gifts, productCategory, expense } =
    await createFixtureGraph(page, async (create) => {
      const { id: clothing } = await create("spendingCategory", {
        name: categoryName,
      });
      const { id: gifts } = await create("spendingCategory", {
        name: "Synthetic classification gifts",
      });
      const { id: productCategory } = await create("productCategory", {
        name: "Synthetic classification shoes",
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
      return { clothing, gifts, productCategory, expense };
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
  const read = async () => {
    const response = await entityApi(page.request).get("expense", expense, {});
    expect(response.ok(), await response.text()).toBeTruthy();
    return z
      .object({
        cost: z.number(),
        spendingCategoryId: z.string().nullable(),
        fieldResolutions: z.object({
          spendingCategoryId: z.object({
            mode: z.string(),
            storedValue: z.string().nullable(),
          }),
        }),
      })
      .parse(await response.json());
  };
  await gotoAuthenticatedPage(
    page,
    `/product-categories/${productCategory}`,
    page.getByRole("button", { name: "Preview historical impact" }),
  );
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
  expect((await read()).spendingCategoryId).toBeNull();
  await patch(expense, { cost: 61 });
  await page.getByRole("button", { name: "Apply reviewed change" }).click();
  await expect(
    page.getByText(/changed after preview; review a fresh preview/).first(),
  ).toBeVisible();
  expect((await read()).spendingCategoryId).toBeNull();
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
    spendingCategoryId: clothing,
    fieldResolutions: {
      spendingCategoryId: { mode: "inherit", storedValue: null },
    },
  });
  await patch(expense, { spendingCategoryId: gifts });
  expect(await read()).toMatchObject({
    spendingCategoryId: gifts,
    fieldResolutions: {
      spendingCategoryId: { mode: "explicit", storedValue: gifts },
    },
  });
});
