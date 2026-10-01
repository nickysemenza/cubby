import { z } from "zod";
import { gotoAuthenticatedPage, selectComboboxItem } from "./e2e-helpers";
import { expect, test } from "./e2e-test";

// One real browser/backend journey guards review freshness, live historical
// mapping, explicit purpose precedence, reset and canonical cent totals.
test("reviews historical item classification and preserves explicit purpose", async ({
  page,
  baseURL,
}) => {
  const headers = { Origin: baseURL! };
  const create = async (
    path: string,
    data: z.infer<ReturnType<typeof z.json>>,
  ) => {
    const response = await page.request.post(`/api/v1/${path}`, {
      headers,
      data,
    });
    expect(response.status(), await response.text()).toBe(201);
    return z
      .object({ item: z.object({ id: z.string() }) })
      .parse(await response.json()).item.id;
  };
  const categoryName = "Synthetic classification clothing";
  const clothing = await create("spending-categories", { name: categoryName });
  const gifts = await create("spending-categories", {
    name: "Synthetic classification gifts",
  });
  const productCategory = await create("product-categories", {
    name: "Synthetic classification shoes",
  });
  const vendor = await create("vendors", {
    name: "Synthetic classification mixed shop",
    spendingProfile: "mixed_retail",
  });
  const product = await create("products", {
    name: "Synthetic classification boots",
    manufacturer: "Synthetic",
    categoryId: productCategory,
  });
  const purchase = await create("purchases", {
    vendorId: vendor,
    date: "2026-09-01",
  });
  const expense = await create("expenses", {
    name: "Synthetic classification boots",
    cost: 60,
    date: "2026-09-01",
    costType: "materials",
    trade: "other",
    productId: product,
    purchaseId: purchase,
  });
  const patch = async (
    id: string,
    data: z.infer<ReturnType<typeof z.json>>,
  ) => {
    const response = await page.request.patch(`/api/v1/expenses/${id}`, {
      headers,
      data,
    });
    expect(response.ok(), await response.text()).toBeTruthy();
  };
  const read = async () => {
    const response = await page.request.get(`/api/v1/expenses/${expense}`);
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
  await page
    .getByRole("combobox", { name: "Product category mapping", exact: true })
    .selectOption("mapped");
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
  await page.screenshot({
    path: "/tmp/cubby-classification-review-desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 402, height: 874 });
  await page.screenshot({
    path: "/tmp/cubby-classification-review-phone.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 1440, height: 900 });
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
  await patch(expense, { spendingCategoryId: null });
  expect(await read()).toMatchObject({
    cost: 61,
    spendingCategoryId: clothing,
    fieldResolutions: {
      spendingCategoryId: { mode: "inherit", storedValue: null },
    },
  });
  const filtered = await page.request.get("/api/v1/expenses", {
    params: {
      spendingCategoryId: clothing,
      page: "1",
      pageSize: "10",
      sort: "spendingCategoryId",
    },
  });
  expect(filtered.ok(), await filtered.text()).toBeTruthy();
  expect(
    z
      .object({ items: z.array(z.object({ id: z.string() })) })
      .parse(await filtered.json())
      .items.map((row) => row.id),
  ).toContain(expense);
});
