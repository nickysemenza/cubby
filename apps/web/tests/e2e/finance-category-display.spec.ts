import { z } from "zod";
import { spendingCategorySummarySchema } from "@cubby/schemas/spending-classification";
import { fieldResolutionSchema } from "@cubby/schemas/field-resolution";
import { gotoAuthenticatedPage, selectComboboxItem } from "./e2e-helpers";
import { expect, test } from "./e2e-test";
import { dispatchesOperation, unbatchFor } from "./dispatch-wire";

test("linked Expense categories display their readable label and transaction expectation", async ({
  page,
  baseURL,
}) => {
  const tag = `Synthetic category display ${Date.now()}`;
  const categoryName = `${tag} dining`;
  const create = async (path: string, data: unknown) => {
    const response = await page.request.post(`/api/v1/${path}`, {
      headers: { Origin: baseURL! },
      data: z.json().parse(data),
    });
    expect(response.status(), await response.text()).toBe(201);
    return z
      .object({ item: z.object({ id: z.string() }) })
      .parse(await response.json()).item.id;
  };
  const categoryId = await create("spending-categories", {
    name: categoryName,
    evidenceExpectation: "not_expected",
    productExpectation: "not_expected",
  });
  const accountId = await create("financial-accounts", {
    name: tag,
    identity: { kind: "credit_card", issuer: null, network: "visa" },
  });
  const vendorId = await create("vendors", { name: tag });
  const purchaseId = await create("purchases", {
    vendorId,
    date: "2026-09-10",
    evidenceExpectation: "not_expected",
  });
  await create("expenses", {
    name: `${tag} meal`,
    purchaseId,
    cost: 23,
    date: "2026-09-10",
    costType: "materials",
    spendingCategoryId: categoryId,
  });
  const transactionId = await create("financial-transactions", {
    accountId,
    amount: 23,
    merchant: tag,
    kind: "purchase",
    status: "posted",
    postedDate: "2026-09-10",
    purchaseId,
  });
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
  baseURL,
}) => {
  const tag = `Synthetic policy draft ${Date.now()}`;
  const create = async (path: string, data: unknown) => {
    const response = await page.request.post(`/api/v1/${path}`, {
      headers: { Origin: baseURL! },
      data: z.json().parse(data),
    });
    expect(response.status(), await response.text()).toBe(201);
    return z
      .object({ item: z.object({ id: z.string() }) })
      .parse(await response.json()).item.id;
  };
  const oldCategory = await create("spending-categories", {
    name: `${tag} original`,
    evidenceExpectation: "required",
    productExpectation: "not_expected",
  });
  const newCategoryName = `${tag} replacement`;
  const newCategory = await create("spending-categories", {
    name: newCategoryName,
    evidenceExpectation: "not_expected",
    productExpectation: "not_expected",
  });
  const vendorId = await create("vendors", { name: tag });
  const purchaseId = await create("purchases", {
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
    .getByRole("button", { name: "Save purchase", exact: true })
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
