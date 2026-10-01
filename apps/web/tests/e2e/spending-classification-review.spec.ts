import { spendingClassificationReviewPreview } from "@cubby/schemas/spending-classification-review";
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
  const tools = await create("spending-categories", {
    name: "Synthetic classification tools",
  });
  const toolsCategory = await create("product-categories", {
    name: "Synthetic classification tools parent",
  });
  const storage = await create("product-categories", {
    name: "Synthetic classification tool storage",
    parentId: toolsCategory,
  });
  const unbooked = await create("products", {
    name: "Synthetic unbooked toolbox",
    manufacturer: "Synthetic",
    categoryId: productCategory,
  });
  const refund = await create("expenses", {
    name: "Synthetic retained item adjustment",
    cost: -10,
    productQuantity: 0,
    date: "2026-09-02",
    costType: "materials",
    trade: "other",
    productId: product,
    purchaseId: purchase,
  });
  const preview = async (request: z.infer<ReturnType<typeof z.json>>) => {
    const response = await page.request.post(
      "/api/v1/spendingClassification/preview",
      { headers, data: { request } },
    );
    expect(response.ok(), await response.text()).toBeTruthy();
    return spendingClassificationReviewPreview.parse(await response.json());
  };
  const apply = async (
    review: z.infer<typeof spendingClassificationReviewPreview>,
  ) =>
    page.request.post("/api/v1/spendingClassification/apply", {
      headers,
      data: { request: review.request, fingerprint: review.fingerprint },
    });
  const mapping = await preview({
    action: "productCategory",
    productCategoryId: toolsCategory,
    spendingCategoryMode: "mapped",
    spendingCategoryId: tools,
  });
  expect((await apply(mapping)).ok()).toBeTruthy();
  const reassignment = {
    action: "products",
    productIds: [product, unbooked],
    productCategoryId: storage,
  };
  const stale = await preview(reassignment);
  expect(stale.changedExpenseCount).toBe(1);
  const changed = await page.request.patch(`/api/v1/products/${unbooked}`, {
    headers,
    data: { categoryId: storage },
  });
  expect(changed.ok(), await changed.text()).toBeTruthy();
  const refused = await apply(stale);
  expect(refused.ok()).toBeFalsy();
  expect(await refused.text()).toContain("changed after preview");
  const reviewed = await preview(reassignment);
  expect(
    reviewed.categoryDeltas.reduce(
      (sum, row) => sum + Number(row.deltaCents),
      0,
    ),
  ).toBe(0);
  expect((await apply(reviewed)).ok()).toBeTruthy();
  expect(await read()).toMatchObject({ cost: 61, spendingCategoryId: gifts });
  const refundRead = await page.request.get(`/api/v1/expenses/${refund}`);
  expect(await refundRead.json()).toMatchObject({
    cost: -10,
    productQuantity: 0,
    spendingCategoryId: tools,
  });

  await gotoAuthenticatedPage(
    page,
    `/expenses/${expense}`,
    page.getByRole("button", {
      name: "How spending category is determined",
      exact: true,
    }),
  );
  const explanation = page.getByRole("button", {
    name: "How spending category is determined",
    exact: true,
  });
  await explanation.click();
  await expect(
    page.getByText("Without the override", { exact: true }),
  ).toBeVisible();
  await expect(
    page
      .getByText("Synthetic classification tools parent", { exact: true })
      .last(),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 402, height: 874 });
  let failExplanation = true;
  await page.route("**/api/browser/dispatch", async (route) => {
    if (
      failExplanation &&
      route.request().postData()?.includes("fieldExplanation.explain")
    ) {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ message: "Synthetic explanation unavailable" }),
      });
    } else await route.continue();
  });
  // A different field has no cached explanation, so the failed lazy read is observable.
  await page
    .getByRole("button", { name: "How trade is determined", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Retry explanation" }),
  ).toBeVisible();
  failExplanation = false;
  await page.getByRole("button", { name: "Retry explanation" }).click();
  await expect(page.getByText("In effect", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 1440, height: 900 });
  await patch(expense, { spendingCategoryId: null });
  expect(await read()).toMatchObject({
    cost: 61,
    spendingCategoryId: tools,
    fieldResolutions: {
      spendingCategoryId: { mode: "inherit", storedValue: null },
    },
  });
  const filtered = await page.request.get("/api/v1/expenses", {
    params: {
      spendingCategoryId: tools,
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
  await gotoAuthenticatedPage(
    page,
    `/purchases/${purchase}#expenses`,
    page.locator("#expenses"),
  );
  const tableExplanation = page
    .locator("#expenses")
    .getByRole("button", {
      name: "How spending category is determined",
      exact: true,
    })
    .first();
  await expect(tableExplanation).toBeVisible();
  await tableExplanation.click();
  await expect(page.getByText("In effect", { exact: true })).toBeVisible();
  await expect(page.getByText("Hierarchy", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 402, height: 874 });
  const phoneExplanation = page
    .locator("#expenses")
    .getByRole("button", {
      name: "How spending category is determined",
      exact: true,
    })
    .first();
  await phoneExplanation.click();
  await expect(page.getByText("In effect", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
});
