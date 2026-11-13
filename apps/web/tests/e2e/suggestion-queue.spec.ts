import { seedFieldSuggestion } from "tooling/shared-suggestion-fixtures";
import { eq, inArray } from "drizzle-orm";

import { getDb } from "~/server/db/helpers";
import { product as productTable } from "~/server/db/schema";

import { publishProductPair } from "~/server/domains/product/repo/match/product-match-candidate";

import { resolveOrThrow } from "~/server/generic/shortcode/repo/shortcode-resolver";

import {
  createFixtureGraph,
  createEvidenceHarnessContext,
} from "./fixtures/core";
import { gotoAuthenticatedPage, uniqueName } from "./support/e2e-helpers";
import { expect, test } from "./support/e2e-test";

// Failure modes: Changes by Cubby omits a value Cubby set on its own, or
// "Wrong, clear it" leaves the wrong value saved.
test("Changes by Cubby lists a value Cubby set and Wrong, clear it empties the field", async ({
  page,
}, testInfo) => {
  test.slow();
  const { db, actor } = await createEvidenceHarnessContext(page);
  const categoryName = uniqueName(testInfo, "Synthetic cleared category");
  const category = await createEntityFixture(page, "productCategory", {
    name: categoryName,
  });
  const productName = uniqueName(testInfo, "Synthetic cleared drill");
  const item = await createEntityFixture(page, "product", {
    name: productName,
  });
  const itemId = await resolveOrThrow(db, "product", item.id);
  const runId = await ensureRun(db, actor, { purpose: "ai_suggest" });
  const suggestion = await seedFieldSuggestion(db, {
    runId,
    entity: "product",
    recordId: itemId,
    field: "categoryId",
    currentValue: null,
    suggestedValue: category.id,
    confidence: 0.97,
    runnerUpValue: null,
    runnerUpConfidence: null,
    model: "typesafe/jev",
    kind: "addition",
    status: "pending",
  });
  const categoryOf = async () =>
    (
      await getDb(db)
        .select({ categoryId: productTable.categoryId })
        .from(productTable)
        .where(eq(productTable.id, itemId))
    )[0]?.categoryId ?? null;
  const applied = await applyAutomaticRules(db, [suggestion.id], {
    context: buildCrudServices,
  });
  expect(applied.applied).toHaveLength(1);
  expect(await categoryOf()).toBe(
    await resolveOrThrow(db, "productCategory", category.id),
  );

  await gotoAuthenticatedPage(page, `/automatic-decisions?record=${item.id}`);
  const feed = page.getByRole("region", {
    name: "Changes by Cubby",
    exact: true,
  });
  await expect(feed.getByRole("link", { name: productName })).toBeVisible();
  await expect(feed).toContainText(categoryName);
  await expect(feed).toContainText("97%");
  await feed
    .getByRole("button", { name: /^Wrong, clear it/ })
    .first()
    .click();
  await expect(
    feed.getByText("Cleared. Cubby will try again.", { exact: true }),
  ).toBeVisible();
  await expect.poll(categoryOf).toBeNull();
});

// Identity conflicts cannot merge; matching pairs still require survivor and impact confirmation.
test("new proposal families require explicit review and preserve merge confirmation", async ({
  page,
}, testInfo) => {
  test.slow();
  const { db } = await createEvidenceHarnessContext(page);
  const { first, second, conflicted } = await createFixtureGraph(
    page,
    async (create) => {
      const brand = await create("vendor", {
        name: uniqueName(testInfo, "Example Tools"),
      });
      const first = await create("product", {
        name: uniqueName(testInfo, "Synthetic matching drill"),
        brandId: brand.id,
        model: "SYN-DRILL-17",
      });
      const second = await create("product", {
        name: uniqueName(testInfo, "Synthetic matching drill duplicate"),
        brandId: brand.id,
        model: "SYN-DRILL-17",
      });
      const conflicted = await create("product", {
        name: uniqueName(testInfo, "Synthetic conflicting drill"),
        brandId: brand.id,
        model: "SYN-DRILL-29",
      });
      return { first, second, conflicted };
    },
  );
  const firstId = await resolveOrThrow(db, "product", first.id);
  const secondId = await resolveOrThrow(db, "product", second.id);
  await publishProductPair(db, {
    productIds: [firstId, secondId],
    source: "agent",
    evidence: "Synthetic identical-model evidence",
    sourceUrls: [],
    actionable: true,
  });
  await publishProductPair(db, {
    productIds: [firstId, await resolveOrThrow(db, "product", conflicted.id)],
    source: "agent",
    evidence: "Synthetic conflicting-model evidence",
    sourceUrls: [],
    actionable: true,
    conflict: true,
  });
  await gotoAuthenticatedPage(page, "/suggestions");
  const table = page.getByRole("table", { name: "Suggestions", exact: true });
  const conflictRow = table
    .getByRole("row")
    .filter({ hasText: "Synthetic conflicting-model evidence" });
  await expect(
    conflictRow.getByRole("button", { name: "Review merge", exact: true }),
  ).toHaveCount(0);
  await gotoAuthenticatedPage(
    page,
    `/suggestions?family=product_pair&record=product:${second.id}`,
  );
  await page.getByRole("button", { name: "Review merge", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByText("Keep (target):", { exact: true }),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Merge", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect
    .poll(
      async () =>
        (
          await getDb(db)
            .select({ deletedAt: productTable.deletedAt })
            .from(productTable)
            .where(
              eq(
                productTable.id,
                await resolveOrThrow(db, "product", conflicted.id),
              ),
            )
        )[0]?.deletedAt,
    )
    .toBeNull();
  const merged = await getDb(db)
    .select({ deletedAt: productTable.deletedAt })
    .from(productTable)
    .where(inArray(productTable.id, [firstId, secondId]));
  expect(merged.filter((row) => row.deletedAt !== null)).toHaveLength(1);
  expect(merged.filter((row) => row.deletedAt === null)).toHaveLength(1);
});
