import { entityApi } from "./support/entity-api";
import { z } from "zod";
import { spendingCategorySummarySchema } from "@cubby/schemas/spending-classification";
import { fieldResolutionSchema } from "@cubby/schemas/field-resolution";
import {
  openCellExplanation,
  gotoAuthenticatedPage,
  selectComboboxItem,
} from "./support/e2e-helpers";
import { expect, test } from "./support/e2e-test";
import { createEntityFixture, createEntityFixtures } from "./fixtures/core";
import {
  dispatchesOperation,
  performOperation,
  unbatchFor,
} from "./support/dispatch-wire";

test("linked Expense categories display their readable label and transaction expectation", async ({
  page,
  baseURL,
}) => {
  test.setTimeout(60_000);
  const tag = `Synthetic category display ${Date.now()}`;
  const categoryName = `${tag} dining`;
  const { id: categoryId } = await createEntityFixture(
    page,
    "spendingCategory",
    {
      name: categoryName,
      itemizationExpectation: "not_expected",
      productExpectation: "not_expected",
    },
  );
  const { id: accountId } = await createEntityFixture(
    page,
    "financialAccount",
    {
      name: tag,
      identity: { kind: "credit_card", issuer: null, network: "visa" },
    },
  );
  const { id: vendorId } = await createEntityFixture(page, "vendor", {
    name: tag,
  });
  const { id: purchaseId } = await createEntityFixture(page, "purchase", {
    vendorId,
    date: "2026-09-10",
    itemizationExpectation: "not_expected",
  });
  // Category coverage counts Expense lines independently of Product links.
  await createEntityFixtures(
    page,
    "expense",
    Array.from({ length: 28 }, () => ({
      name: `${tag} meal`,
      purchaseId,
      cost: -2,
      date: "2026-09-10",
      costType: "materials",
      trade: "other",
      spendingCategoryId: categoryId,
    })),
  );
  const { id: transactionId } = await createEntityFixture(
    page,
    "financialTransaction",
    {
      accountId,
      amount: -56,
      merchant: tag,
      kind: "refund",
      status: "posted",
      postedDate: "2026-09-10",
      purchaseId,
    },
  );
  const saved = await entityApi(page.request).get(
    "financialTransaction",
    transactionId,
    {},
  );
  expect(saved.ok(), await saved.text()).toBeTruthy();
  expect(
    z
      .object({
        spendingCategoryId: z.null(),
        spendingCategorySummary: spendingCategorySummarySchema,
        itemizationExpectation: z.null(),
        coverage: z.object({ expectation: z.string() }),
        fieldResolutions: z.object({
          itemizationExpectation: fieldResolutionSchema,
        }),
      })
      .parse(await saved.json()),
  ).toMatchObject({
    spendingCategoryId: null,
    spendingCategorySummary: {
      state: "single",
      categories: [{ id: categoryId, name: categoryName, amount: null }],
      complete: true,
      amountsKnown: false,
    },
    itemizationExpectation: null,
    coverage: { expectation: "not_expected" },
    fieldResolutions: {
      itemizationExpectation: {
        mode: "inherit",
        storedValue: null,
        value: "not_expected",
        fallbackValue: "not_expected",
        sourceEntity: { entityKind: "purchase", entityId: purchaseId },
        canReset: false,
      },
    },
  });
  const enrichment = page.waitForResponse(
    (response) =>
      dispatchesOperation(response.request(), "entity.listEnrichment") &&
      response.ok(),
  );
  await gotoAuthenticatedPage(
    page,
    `/financial-transactions?search=${encodeURIComponent(tag)}`,
  );
  const row = page.getByRole("row").filter({ hasText: tag });
  await enrichment;
  await expect(row).toBeVisible();
  await expect(row.getByLabel("Loading field")).toHaveCount(0);
  const category = row.getByText(categoryName, { exact: true });
  await expect(category).toBeVisible();
  await expect(category).toHaveText(categoryName);
  // Headers paint short labels; the full label is the header's tooltip.
  const headers = await page
    .getByRole("columnheader")
    .evaluateAll((cells) =>
      cells.map(
        (cell) =>
          cell.querySelector("[data-header-label]")?.getAttribute("title") ??
          "",
      ),
    );
  const expectationIndex = headers.indexOf("Itemization expectation");
  expect(expectationIndex).toBeGreaterThanOrEqual(0);
  await expect(row.getByRole("cell").nth(expectationIndex)).toContainText(
    "Not expected",
  );
  await openCellExplanation(row, "How expense categories is determined");
  const popover = page.locator('[data-slot="popover-content"]');
  await expect(popover).toContainText("Single category");
  await expect(popover).toContainText(
    "28 of 28 linked expense lines are classified",
  );
  await expect(popover).toContainText("Technical details");
  await expect(popover).toContainText("28 of 28 linked expense lines");
  await expect(popover).toContainText(
    "Settlement allocations do not attribute",
  );

  await page.keyboard.press("Escape");
  await openCellExplanation(row, "How itemization is determined");
  await expect(popover).toContainText("Technical details");
  await expect(
    popover.getByText("Confirmed allocations 1", { exact: true }),
  ).toBeVisible();
  await expect(
    popover.getByText("Confirmed allocations", { exact: true }),
  ).toHaveCount(0);
  await popover
    .getByRole("button", { name: "Technical details", exact: true })
    .click();
  await expect(popover).toContainText("Itemization compares the purchase");
  await expect(popover).toContainText("Itemized, matches");
  await expect(popover).toContainText("-$56.00");

  await page.keyboard.press("Escape");
  const unchanged = await entityApi(page.request).get(
    "financialTransaction",
    transactionId,
    {},
  );
  expect(
    z
      .object({
        itemizationExpectation: z.null(),
        spendingCategoryId: z.null(),
      })
      .parse(await unchanged.json()),
  ).toEqual({ itemizationExpectation: null, spendingCategoryId: null });
  const updated = await entityApi(page.request).update(
    "financialTransaction",
    transactionId,
    { itemizationExpectation: "required" },
    { headers: { Origin: baseURL! } },
  );
  expect(updated.ok(), await updated.text()).toBeTruthy();
  const reloaded = page.waitForResponse(
    (response) =>
      dispatchesOperation(response.request(), "entity.listEnrichment") &&
      response.ok(),
  );
  await page.reload();
  await reloaded;
  await expect(row.getByLabel("Loading field")).toHaveCount(0);
  await expect(category).toHaveText(categoryName);
  await expect(row.getByRole("cell").nth(expectationIndex)).toContainText(
    "Expected",
  );
  const explicit = await entityApi(page.request).get(
    "financialTransaction",
    transactionId,
    {},
  );
  expect(
    z
      .object({
        itemizationExpectation: z.string(),
        coverage: z.object({ expectation: z.string() }),
      })
      .parse(await explicit.json()),
  ).toEqual({
    itemizationExpectation: "required",
    coverage: { expectation: "required" },
  });
  await gotoAuthenticatedPage(page, `/financial-transactions/${transactionId}`);
  await expect(
    page.getByText("Set here", { exact: true }).first(),
  ).toBeVisible();
  await performOperation(page, "entity.mutate", () =>
    page
      .getByRole("button", { name: "Use inherited", exact: true })
      .first()
      .click(),
  );
  const inherited = await entityApi(page.request).get(
    "financialTransaction",
    transactionId,
    {},
  );
  expect(
    z
      .object({
        itemizationExpectation: z.string().nullable(),
        fieldResolutions: z.object({
          itemizationExpectation: fieldResolutionSchema,
        }),
      })
      .parse(await inherited.json()),
  ).toMatchObject({
    itemizationExpectation: null,
    fieldResolutions: {
      itemizationExpectation: { mode: "inherit", value: "not_expected" },
    },
  });
  await expect(
    page
      .locator(
        `[data-slot="field-resolution"] a[href="/purchases/${purchaseId}"]`,
      )
      .first(),
  ).toBeVisible();
});

test("draft category edits hide obsolete policy provenance while the replacement request is pending", async ({
  page,
}) => {
  const tag = `Synthetic policy draft ${Date.now()}`;
  const { id: oldCategory } = await createEntityFixture(
    page,
    "spendingCategory",
    {
      name: `${tag} original`,
      itemizationExpectation: "required",
      productExpectation: "not_expected",
    },
  );
  const newCategoryName = `${tag} replacement`;
  const { id: newCategory } = await createEntityFixture(
    page,
    "spendingCategory",
    {
      name: newCategoryName,
      itemizationExpectation: "not_expected",
      productExpectation: "not_expected",
    },
  );
  const { id: vendorId } = await createEntityFixture(page, "vendor", {
    name: tag,
  });
  const { id: purchaseId } = await createEntityFixture(page, "purchase", {
    vendorId,
    date: "2026-09-10",
    spendingCategoryId: oldCategory,
  });
  await gotoAuthenticatedPage(page, `/purchases/${purchaseId}`);
  const suggestionRequest = z.object({
    json: z.object({
      operation: z.string(),
      input: z.looseObject({
        basis: z.record(z.string(), z.string().nullable()),
      }),
    }),
  });
  const persisted = await entityApi(page.request).get(
    "purchase",
    purchaseId,
    {},
  );
  expect(
    z
      .object({
        fieldResolutions: z.object({
          itemizationExpectation: fieldResolutionSchema,
        }),
      })
      .parse(await persisted.json()).fieldResolutions.itemizationExpectation,
  ).toMatchObject({
    mode: "inherit",
    value: "required",
    sourceEntity: { entityId: oldCategory },
  });
  await page.getByRole("button", { name: /Edit Purchase/i }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  const oldSource = dialog.locator(
    `[data-slot="field-resolution"] a[href="/spending-categories/${oldCategory}"]`,
  );
  await expect(oldSource).toBeVisible();

  let releaseRequest = () => {};
  const released = new Promise<void>((resolve) => {
    releaseRequest = resolve;
  });
  let requestBlocked = false;
  await page.route("**/api/operations/*", async (route) => {
    if (await unbatchFor(route, ["ai.suggestFields"])) return;
    const request = suggestionRequest.safeParse(route.request().postDataJSON());
    if (
      request.success &&
      request.data.json.operation === "ai.suggestFields" &&
      request.data.json.input.basis.spendingCategoryId === newCategory
    ) {
      requestBlocked = true;
      await released;
    }
    await route.continue();
  });
  try {
    await selectComboboxItem(
      page,
      dialog.getByRole("combobox", { name: /Fallback category/i }),
      newCategoryName,
    );
    await expect.poll(() => requestBlocked).toBe(true);
    // The pending draft has no authoritative source yet; the old query must not supply one.
    await expect(oldSource).toHaveCount(0);
  } finally {
    releaseRequest();
  }
  const saved = await entityApi(page.request).get("purchase", purchaseId, {});
  expect(
    z
      .object({
        spendingCategoryId: z.string(),
        itemizationExpectation: z.null(),
      })
      .parse(await saved.json()),
  ).toEqual({
    spendingCategoryId: oldCategory,
    itemizationExpectation: null,
  });
  await performOperation(page, "entity.mutate", () =>
    dialog.getByRole("button", { name: "Save changes", exact: true }).click(),
  );
  await expect(dialog).toHaveCount(0);
  const updated = await entityApi(page.request).get("purchase", purchaseId, {});
  expect(
    z
      .object({
        spendingCategoryId: z.string(),
        itemizationExpectation: z.null(),
        fieldResolutions: z.object({
          itemizationExpectation: fieldResolutionSchema,
        }),
      })
      .parse(await updated.json()),
  ).toMatchObject({
    spendingCategoryId: newCategory,
    itemizationExpectation: null,
    fieldResolutions: {
      itemizationExpectation: {
        mode: "inherit",
        value: "not_expected",
        sourceEntity: { entityId: newCategory },
      },
    },
  });
});

// A complete allocation can have no singular category id. Tables must expose
// the same effective classification that quality checks evaluate.
test("expense category pills agree with quality for direct, allocated, and missing categories", async ({
  page,
}) => {
  const tag = `Synthetic strict quality ${Date.now()}`;
  const categoryName = `${tag} supplies`;
  const { id: categoryId } = await createEntityFixture(
    page,
    "spendingCategory",
    {
      name: categoryName,
      itemizationExpectation: "not_expected",
      productExpectation: "not_expected",
    },
  );
  const { id: vendorId } = await createEntityFixture(page, "vendor", {
    name: tag,
  });
  const { id: purchaseId } = await createEntityFixture(page, "purchase", {
    vendorId,
    date: "2026-09-10",
    itemizationExpectation: "not_expected",
  });
  const { id: principal } = await createEntityFixture(page, "expense", {
    name: `${tag} principal`,
    costType: "services",
    trade: "other",
    purchaseId,
    cost: 20,
    date: "2026-09-10",
    spendingCategoryId: categoryId,
  });
  const secondCategoryName = `${tag} services`;
  const { id: secondCategoryId } = await createEntityFixture(
    page,
    "spendingCategory",
    {
      name: secondCategoryName,
      itemizationExpectation: "not_expected",
      productExpectation: "not_expected",
    },
  );
  await createEntityFixture(page, "expense", {
    name: `${tag} second principal`,
    costType: "services",
    trade: "other",
    purchaseId,
    cost: 10,
    date: "2026-09-10",
    spendingCategoryId: secondCategoryId,
  });
  const { id: adjustment } = await createEntityFixture(page, "expense", {
    name: `${tag} shipping`,
    costType: "services",
    purchaseId,
    lineKind: "shipping",
    cost: 3,
    date: "2026-09-10",
  });
  const { id: missing } = await createEntityFixture(page, "expense", {
    name: `${tag} unclassified`,
    costType: "services",
    trade: "other",
    cost: 10,
    date: "2026-09-10",
  });
  const read = async (id: string) => {
    const response = await entityApi(page.request).get("expense", id, {});
    expect(response.ok(), await response.text()).toBeTruthy();
    return z
      .object({
        dataQuality: z.object({
          score: z.number().nullable(),
          gaps: z.array(z.object({ check: z.string() })),
        }),
      })
      .parse(await response.json()).dataQuality;
  };
  expect((await read(missing)).score).toBeLessThan(100);
  expect((await read(missing)).gaps.map((gap) => gap.check)).toContain(
    "expense_spending_category",
  );
  expect((await read(principal)).gaps.map((gap) => gap.check)).not.toContain(
    "expense_spending_category",
  );
  expect((await read(adjustment)).gaps.map((gap) => gap.check)).not.toContain(
    "expense_spending_category",
  );
  await gotoAuthenticatedPage(page, `/expenses?q=${encodeURIComponent(tag)}`);
  const principalRow = page
    .getByRole("row")
    .filter({ hasText: `${tag} principal` });
  const directCategory = principalRow.getByRole("link", {
    name: categoryName,
    exact: true,
  });
  await expect(directCategory).toBeVisible();
  await expect(directCategory).toHaveAttribute(
    "href",
    `/spending-categories/${categoryId}`,
  );
  await expect(principalRow.getByText(categoryId, { exact: true })).toHaveCount(
    0,
  );

  // Standard-height pills fit one line. Allocated categories retain the first
  // link and name the remainder through the shared cluster's overflow tooltip.
  const shipping = page.getByRole("row").filter({ hasText: `${tag} shipping` });
  const allocatedCategory = shipping.locator(
    'a[href^="/spending-categories/"]',
  );
  await expect(allocatedCategory).toHaveCount(1);
  const visibleName = await allocatedCategory.innerText();
  expect([categoryName, secondCategoryName]).toContain(visibleName);
  const visibleId =
    visibleName === categoryName ? categoryId : secondCategoryId;
  const hiddenName =
    visibleName === categoryName ? secondCategoryName : categoryName;
  await expect(allocatedCategory).toHaveAttribute(
    "href",
    `/spending-categories/${visibleId}`,
  );
  const overflow = shipping.getByRole("button", {
    name: `1 more: ${hiddenName}`,
    exact: true,
  });
  await overflow.hover();
  await expect(
    page.locator('[data-slot="tooltip-content"]').filter({ visible: true }),
  ).toHaveText(hiddenName);
  const row = page.getByRole("row").filter({ hasText: `${tag} unclassified` });
  await expect(row).not.toContainText("100/100");

  // The full record keeps both allocated categories navigable.
  await gotoAuthenticatedPage(page, `/expenses/${adjustment}`);
  await expect(
    page.getByRole("link", { name: categoryName, exact: true }).first(),
  ).toHaveAttribute("href", `/spending-categories/${categoryId}`);
  await expect(
    page.getByRole("link", { name: secondCategoryName, exact: true }).first(),
  ).toHaveAttribute("href", `/spending-categories/${secondCategoryId}`);
});
