import { z } from "zod";
import { spendingCategorySummarySchema } from "@cubby/schemas/spending-classification";
import { fieldResolutionSchema } from "@cubby/schemas/field-resolution";
import { gotoAuthenticatedPage, selectComboboxItem } from "./e2e-helpers";
import { expect, test } from "./e2e-test";
import { createEntityFixture } from "./fixtures-core";
import { dispatchesOperation, unbatchFor } from "./dispatch-wire";

test("linked Expense categories display their readable label and transaction expectation", async ({
  page,
  baseURL,
}, testInfo) => {
  test.setTimeout(60_000);
  const tag = `Synthetic category display ${Date.now()}`;
  const categoryName = `${tag} dining`;
  const { id: categoryId } = await createEntityFixture(
    page,
    "spendingCategory",
    {
      name: categoryName,
      evidenceExpectation: "not_expected",
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
    evidenceExpectation: "not_expected",
  });
  const { id: productId } = await createEntityFixture(page, "product", {
    name: `${tag} item`,
    manufacturer: "Synthetic",
  });
  for (let index = 0; index < 28; index += 1) {
    await createEntityFixture(page, "expense", {
      name: `${tag} meal`,
      purchaseId,
      cost: -2,
      productId,
      productQuantity: -1,
      date: "2026-09-10",
      costType: "materials",
      trade: "other",
      spendingCategoryId: categoryId,
    });
  }
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
  const saved = await page.request.get(
    `/api/v1/financial-transactions/${transactionId}`,
  );
  expect(saved.ok(), await saved.text()).toBeTruthy();
  expect(
    z
      .object({
        spendingCategoryId: z.null(),
        spendingCategorySummary: spendingCategorySummarySchema,
        evidenceExpectation: z.null(),
        coverage: z.object({ expectation: z.string() }),
        fieldResolutions: z.object({
          evidenceExpectation: fieldResolutionSchema,
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
    evidenceExpectation: null,
    coverage: { expectation: "not_expected" },
    fieldResolutions: {
      evidenceExpectation: {
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
  const headers = await page.getByRole("columnheader").allTextContents();
  const expectationIndex = headers.findIndex((value) =>
    value.includes("Evidence expectation"),
  );
  expect(expectationIndex).toBeGreaterThanOrEqual(0);
  await expect(row.getByRole("cell").nth(expectationIndex)).toContainText(
    "Not expected",
  );
  await row
    .getByRole("button", { name: "How expense categories is determined" })
    .click();
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
  await page.screenshot({
    path: testInfo.outputPath("expense-categories-explanation.png"),
  });
  await page.keyboard.press("Escape");
  await row
    .getByRole("button", { name: "How itemization is determined" })
    .click();
  await expect(popover).toContainText("Technical details");
  await expect(
    popover.getByText("Confirmed allocations 1", { exact: true }),
  ).toBeVisible();
  await expect(
    popover.getByText("Confirmed allocations", { exact: true }),
  ).toHaveCount(0);
  await expect(popover).toContainText("Itemization compares the purchase");
  await expect(popover).toContainText("Itemized, matches");
  await expect(popover).toContainText("-$56.00");
  await page.screenshot({
    path: testInfo.outputPath("itemization-explanation.png"),
  });
  await page.keyboard.press("Escape");
  const unchanged = await page.request.get(
    `/api/v1/financial-transactions/${transactionId}`,
  );
  expect(
    z
      .object({ evidenceExpectation: z.null(), spendingCategoryId: z.null() })
      .parse(await unchanged.json()),
  ).toEqual({ evidenceExpectation: null, spendingCategoryId: null });
  const updated = await page.request.patch(
    `/api/v1/financial-transactions/${transactionId}`,
    {
      headers: { Origin: baseURL! },
      data: { evidenceExpectation: "required" },
    },
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
  const explicit = await page.request.get(
    `/api/v1/financial-transactions/${transactionId}`,
  );
  expect(
    z
      .object({
        evidenceExpectation: z.string(),
        coverage: z.object({ expectation: z.string() }),
      })
      .parse(await explicit.json()),
  ).toEqual({
    evidenceExpectation: "required",
    coverage: { expectation: "required" },
  });
  await gotoAuthenticatedPage(page, `/financial-transactions/${transactionId}`);
  await expect(
    page.getByText("Set here", { exact: true }).first(),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Use inherited value", exact: true })
    .first()
    .click();
  await expect
    .poll(async () => {
      const response = await page.request.get(
        `/api/v1/financial-transactions/${transactionId}`,
      );
      return z
        .object({
          evidenceExpectation: z.string().nullable(),
          fieldResolutions: z.object({
            evidenceExpectation: fieldResolutionSchema,
          }),
        })
        .parse(await response.json());
    })
    .toMatchObject({
      evidenceExpectation: null,
      fieldResolutions: {
        evidenceExpectation: { mode: "inherit", value: "not_expected" },
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
      evidenceExpectation: "required",
      productExpectation: "not_expected",
    },
  );
  const newCategoryName = `${tag} replacement`;
  const { id: newCategory } = await createEntityFixture(
    page,
    "spendingCategory",
    {
      name: newCategoryName,
      evidenceExpectation: "not_expected",
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
  const persisted = await page.request.get(`/api/v1/purchases/${purchaseId}`);
  expect(
    z
      .object({
        fieldResolutions: z.object({
          evidenceExpectation: fieldResolutionSchema,
        }),
      })
      .parse(await persisted.json()).fieldResolutions.evidenceExpectation,
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
  await page.route("**/api/browser/dispatch", async (route) => {
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
  const saved = await page.request.get(`/api/v1/purchases/${purchaseId}`);
  expect(
    z
      .object({ spendingCategoryId: z.string(), evidenceExpectation: z.null() })
      .parse(await saved.json()),
  ).toEqual({
    spendingCategoryId: oldCategory,
    evidenceExpectation: null,
  });
  await dialog
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  await expect
    .poll(async () => {
      const response = await page.request.get(
        `/api/v1/purchases/${purchaseId}`,
      );
      return z
        .object({
          spendingCategoryId: z.string(),
          evidenceExpectation: z.null(),
          fieldResolutions: z.object({
            evidenceExpectation: fieldResolutionSchema,
          }),
        })
        .parse(await response.json());
    })
    .toMatchObject({
      spendingCategoryId: newCategory,
      evidenceExpectation: null,
      fieldResolutions: {
        evidenceExpectation: {
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
      evidenceExpectation: "not_expected",
      productExpectation: "not_expected",
    },
  );
  const { id: vendorId } = await createEntityFixture(page, "vendor", {
    name: tag,
  });
  const { id: purchaseId } = await createEntityFixture(page, "purchase", {
    vendorId,
    date: "2026-09-10",
    evidenceExpectation: "not_expected",
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
      evidenceExpectation: "not_expected",
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
    const response = await page.request.get(`/api/v1/expenses/${id}`);
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
  for (const name of [`${tag} principal`, `${tag} shipping`]) {
    const row = page.getByRole("row").filter({ hasText: name });
    await expect(
      row.getByRole("link", { name: categoryName, exact: true }),
    ).toBeVisible();
    await expect(
      row.getByRole("link", { name: categoryName, exact: true }),
    ).toHaveAttribute("href", `/spending-categories/${categoryId}`);
    await expect(row.getByText(categoryId, { exact: true })).toHaveCount(0);
  }
  const shipping = page.getByRole("row").filter({ hasText: `${tag} shipping` });
  await expect(
    shipping.getByRole("link", { name: secondCategoryName, exact: true }),
  ).toBeVisible();
  const row = page.getByRole("row").filter({ hasText: `${tag} unclassified` });
  await expect(row).not.toContainText("100/100");
});
