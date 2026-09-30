import { z } from "zod";
import { gotoAuthenticatedPage } from "./e2e-helpers";
import { expect, test } from "./e2e-test";

test("saved transaction categories display their readable label and effective expectation", async ({
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
  const transactionId = await create("financial-transactions", {
    accountId,
    amount: 23,
    merchant: tag,
    kind: "purchase",
    status: "posted",
    postedDate: "2026-09-10",
    spendingCategoryId: categoryId,
  });
  const saved = await page.request.get(
    `/api/v1/financial-transactions/${transactionId}`,
  );
  expect(saved.ok(), await saved.text()).toBeTruthy();
  expect(
    z
      .object({
        spendingCategoryId: z.string(),
        evidenceExpectation: z.null(),
        coverage: z.object({ expectation: z.string() }),
      })
      .parse(await saved.json()),
  ).toMatchObject({
    spendingCategoryId: categoryId,
    evidenceExpectation: null,
    coverage: { expectation: "not_expected" },
  });
  const enrichment = page.waitForResponse(
    (response) =>
      response.request().headers()["x-cubby-operation"] ===
        "entity.listEnrichment" && response.ok(),
  );
  await gotoAuthenticatedPage(
    page,
    `/financial-transactions?search=${encodeURIComponent(tag)}`,
  );
  const row = page.getByRole("row").filter({ hasText: tag });
  await enrichment;
  await expect(row).toBeVisible();
  await expect(row.getByLabel("Loading field")).toHaveCount(0);
  const category = row.locator(`a[href="/spending-categories/${categoryId}"]`);
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
      .object({ evidenceExpectation: z.null(), spendingCategoryId: z.string() })
      .parse(await unchanged.json()),
  ).toEqual({ evidenceExpectation: null, spendingCategoryId: categoryId });
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
      response.request().headers()["x-cubby-operation"] ===
        "entity.listEnrichment" && response.ok(),
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
});
