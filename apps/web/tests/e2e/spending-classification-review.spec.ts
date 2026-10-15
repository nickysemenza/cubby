import { entityApi } from "./entity-api";
import { spendingClassificationReviewPreview } from "@cubby/schemas/spending-classification-review";
import { z } from "zod";
import {
  chooseOption,
  gotoAuthenticatedPage,
  inlineExplanation,
  selectComboboxItem,
} from "./e2e-helpers";
import { expect, test } from "./e2e-test";
import { createEntityFixture } from "./fixtures-core";

// One real browser/backend journey guards review freshness, live historical
// mapping, explicit purpose precedence, reset and canonical cent totals.
test("reviews historical item classification and preserves explicit purpose", async ({
  page,
  baseURL,
}, testInfo) => {
  const headers = { Origin: baseURL! };
  const categoryName = "Synthetic classification clothing";
  const { id: clothing } = await createEntityFixture(page, "spendingCategory", {
    name: categoryName,
  });
  const { id: gifts } = await createEntityFixture(page, "spendingCategory", {
    name: "Synthetic classification gifts",
  });
  const { id: productCategory } = await createEntityFixture(
    page,
    "productCategory",
    {
      name: "Synthetic classification shoes",
    },
  );
  const { id: vendor } = await createEntityFixture(page, "vendor", {
    name: "Synthetic classification mixed shop",
    spendingProfile: "mixed_retail",
  });
  const { id: product } = await createEntityFixture(page, "product", {
    name: "Synthetic classification boots",
    manufacturer: "Synthetic",
    categoryId: productCategory,
  });
  const { id: purchase } = await createEntityFixture(page, "purchase", {
    vendorId: vendor,
    date: "2026-09-01",
  });
  const { id: expense } = await createEntityFixture(page, "expense", {
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
  const toolsName =
    "Synthetic classification tools and household workshop supplies";
  const { id: tools } = await createEntityFixture(page, "spendingCategory", {
    name: toolsName,
  });
  const { id: toolsCategory } = await createEntityFixture(
    page,
    "productCategory",
    {
      name: "Synthetic classification tools parent",
    },
  );
  const { id: storage } = await createEntityFixture(page, "productCategory", {
    name: "Synthetic classification tool storage",
    parentId: toolsCategory,
  });
  const { id: unbooked } = await createEntityFixture(page, "product", {
    name: "Synthetic unbooked toolbox",
    manufacturer: "Synthetic",
    categoryId: productCategory,
  });
  const { id: refund } = await createEntityFixture(page, "expense", {
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
  const changed = await entityApi(page.request).update(
    "product",
    unbooked,
    { categoryId: storage },
    { headers },
  );
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
  const refundRead = await entityApi(page.request).get("expense", refund, {});
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
  await expect(page.getByText("Fallback", { exact: true })).toBeVisible();
  await expect(
    page
      .getByText("Synthetic classification tools parent", { exact: true })
      .last(),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 402, height: 874 });
  const tradeExplanation = page.getByRole("button", {
    name: "How trade is determined",
    exact: true,
  });
  await tradeExplanation.click();
  const popover = await inlineExplanation(page, tradeExplanation);
  await expect(
    popover.getByRole("heading", { name: "Technical details" }),
  ).toBeVisible();
  await expect(async () => {
    const disclosure = popover
      .locator("details")
      .filter({
        has: page.getByRole("heading", { name: "Technical details" }),
      })
      .first();
    if (!(await disclosure.getAttribute("open")))
      await disclosure.locator("summary").first().click();
    await expect(popover.getByText("Rule:", { exact: true })).toBeVisible();
  }).toPass();
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
  const filtered = await entityApi(page.request).list("expense", {
    filters: { spendingCategoryId: tools },
    pagination: { pageIndex: 0, pageSize: 10 },
    sort: [{ orderBy: "spendingCategoryId", direction: "asc" }],
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
  const principalLink = page.locator(`a[href="/expenses/${expense}"]`);
  const openPopover = page.locator('[data-slot="popover-content"][data-open]');
  const expenseRow = page
    .locator("#expenses")
    .getByRole("row")
    .filter({ has: principalLink });
  // A row's explanation appears once the row is hovered or focused.
  await expenseRow.hover();
  const tableExplanation = expenseRow
    .getByRole("button", {
      name: "How spending category is determined",
      exact: true,
    })
    .first();
  await expect(tableExplanation).toBeVisible();
  await expect(async () => {
    if (!(await openPopover.isVisible())) await tableExplanation.click();
    // Short attempts: an early click can miss hydration, and the default
    // expect timeout would spend the whole budget before the retry click.
    await expect(
      openPopover.getByRole("heading", {
        name: "Resolution order",
        exact: true,
      }),
    ).toBeVisible({ timeout: 2_000 });
  }).toPass();
  // The timeline reads nearest source first; the category that supplies the
  // value is marked Used and its value is never truncated.
  await expect(openPopover.getByText("Used", { exact: true })).toBeVisible();
  const winningLabel = openPopover.getByText(toolsName, { exact: true }).last();
  await expect(winningLabel).toBeVisible();
  expect(
    await winningLabel.evaluate((label) => label.scrollWidth),
  ).toBeLessThanOrEqual(
    await winningLabel.evaluate((label) => label.clientWidth),
  );
  await page.screenshot({
    path: testInfo.outputPath("inherited-category-desktop.png"),
  });
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 402, height: 874 });
  const phoneExplanation = page
    .locator("#expenses")
    .getByRole("listitem")
    .filter({ has: principalLink })
    .getByRole("button", {
      name: "How spending category is determined",
      exact: true,
    })
    .first();
  await expect(async () => {
    if (!(await openPopover.isVisible())) await phoneExplanation.click();
    // Short attempts: an early click can miss hydration, and the default
    // expect timeout would spend the whole budget before the retry click.
    await expect(
      openPopover.getByRole("heading", {
        name: "Resolution order",
        exact: true,
      }),
    ).toBeVisible({ timeout: 2_000 });
  }).toPass();
  expect(
    await winningLabel.evaluate((label) => label.scrollWidth),
  ).toBeLessThanOrEqual(
    await winningLabel.evaluate((label) => label.clientWidth),
  );
  await page.screenshot({
    path: testInfo.outputPath("inherited-category-phone.png"),
  });
  await page.keyboard.press("Escape");
  const blocked = await preview({
    action: "productCategory",
    productCategoryId: storage,
    spendingCategoryMode: "blocked",
    spendingCategoryId: null,
  });
  expect((await apply(blocked)).ok()).toBeTruthy();
  await page.reload();
  await expect(async () => {
    if (!(await openPopover.isVisible())) await phoneExplanation.click();
    await expect(
      openPopover.getByRole("heading", {
        name: "Resolution order",
        exact: true,
      }),
    ).toBeVisible({ timeout: 2_000 });
  }).toPass();
  const blockedSource = openPopover.getByRole("listitem").filter({
    has: page.locator(`a[href="/product-categories/${storage}"]`),
  });
  await expect(
    blockedSource.getByText("Blocked", { exact: true }),
  ).toBeVisible();
  await expect(blockedSource.getByTitle("Used", { exact: true })).toBeVisible();
});
