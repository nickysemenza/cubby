import { seedProductPrerequisite } from "./fixtures/catalog";
import {
  seedFieldSuggestion,
  applyFieldAnswerFixture,
} from "tooling/shared-suggestion-fixtures";

import { fieldInputFingerprint } from "~/server/generic/suggestions/repo/field-input-fence";
import { drainDerivedRefreshFrontier } from "~/server/testing/background-queue";
import type { Page } from "@playwright/test";

import { parseEntityId } from "@cubby/schemas/identifiers";
import { eq } from "drizzle-orm";

import { product as productTable } from "~/server/db/schema";
import { ensureRun } from "~/server/domains/run/repo/ensure-run";

import { publishExactSuggestion } from "~/server/generic/suggestions/repo/suggestion-publication";
import { getDb } from "~/server/db/helpers";
import { resolveOrThrow } from "~/server/generic/shortcode/repo/shortcode-resolver";
import { readSuggestionDecisions } from "~/server/testing/suggestion-decisions.fixtures";

import {
  gotoAuthenticatedPage,
  openFoldedFacts,
  uniqueName,
  waitForAppHydration,
} from "./support/e2e-helpers";
import { expect, test } from "./support/e2e-test";

import {
  createEntityFixture,
  createEvidenceHarnessContext,
} from "./fixtures/core";

/** Keep a scenario's generation independent of earlier imports in its worker database. */

/** Synthetic Monarch rows on one account alias. */

const suggestionsTable = (page: Page) =>
  page.getByRole("table", { name: "Suggestions" });

test("reviews a field suggestion for a named record", async ({
  page,
}, testInfo) => {
  const { db, actor } = await createEvidenceHarnessContext(page);
  const categoryName = uniqueName(testInfo, "Suggested category");
  const category = await createEntityFixture(page, "productCategory", {
    name: categoryName,
  });
  const currentCategory = await createEntityFixture(page, "productCategory", {
    name: uniqueName(testInfo, "Member category"),
  });
  const productName = uniqueName(testInfo, "Suggested drill");
  // A member's value Cubby disagrees with is listed; a plain guess is not.
  const item = await createEntityFixture(page, "product", {
    name: productName,
    categoryId: currentCategory.id,
  });
  const itemId = await resolveOrThrow(db, "product", item.id);
  const runId = await ensureRun(db, actor, { purpose: "ai_suggest" });

  const seedCategoryAdvice = async () =>
    seedFieldSuggestion(
      db,
      {
        runId,
        entity: "product",
        recordId: itemId,
        field: "categoryId",
        currentValue: currentCategory.id,
        suggestedValue: category.id,
        confidence: 0.91,
        runnerUpValue: null,
        runnerUpConfidence: null,
        model: "typesafe/jev",
        kind: "correction",
        status: "pending",
        data: {
          liveInputFingerprint: await fieldInputFingerprint(
            db,
            "product",
            itemId,
            "categoryId",
          ),
        },
      },
      true,
    );
  await seedCategoryAdvice();
  await gotoAuthenticatedPage(page, "/products");
  const productRow = page.getByRole("row").filter({ hasText: productName });
  const badge = productRow.getByRole("button", {
    name: "1 pending suggestion",
  });
  await expect(badge).toBeVisible();
  await badge.click();
  await expect(
    page.getByText("Category", { exact: true }).first(),
  ).toBeVisible();
  await gotoAuthenticatedPage(page, `/suggestions?record=product:${item.id}`);
  const rows = suggestionsTable(page).getByRole("row");
  const field = rows
    .filter({ hasText: "Field" })
    .filter({ hasText: "Category" });
  await expect(field).toHaveCount(1);
  const recordLink = field.getByRole("link", { name: productName });
  await expect(recordLink).toBeVisible();
  // The proposed category retains its full-path record label.
  await expect(
    field.locator(`a[href="/product-categories/${category.id}"]`).first(),
  ).toContainText(categoryName);

  expect(
    (
      await getDb(db)
        .select({ categoryId: productTable.categoryId })
        .from(productTable)
        .where(eq(productTable.id, itemId))
    )[0]?.categoryId,
  ).toBe(await resolveOrThrow(db, "productCategory", currentCategory.id));
  await field
    .getByRole("button", { name: new RegExp(`^Use ${categoryName}`) })
    .click();
  await expect
    .poll(
      async () =>
        (
          await getDb(db)
            .select({ categoryId: productTable.categoryId })
            .from(productTable)
            .where(eq(productTable.id, itemId))
        )[0]?.categoryId,
    )
    .toBe(await resolveOrThrow(db, "productCategory", category.id));
  await expect(field).toHaveCount(0);
});

// Failure modes: an attach applies to the first candidate instead of the one
// named; a create counts as clean without decision labels; the clean bulk
// accept skips its confirm or accepts a row it did not list as clean.

// Failure modes: a value Cubby set wears a mark a member's value does not; an
// edit of Cubby's value is lost on reload; the empty field's picker hides
// Cubby's stored guess or marks it selected, or picking it saves something else.
test("Cubby's values read as plain values, edits persist, and the picker offers Cubby's guess", async ({
  page,
}, testInfo) => {
  const { db, actor } = await createEvidenceHarnessContext(page);
  const prefix = uniqueName(testInfo, "Plain value");
  const guessedName = `${prefix} Corner Hardware`;
  const otherName = `${prefix} Garden Supply`;
  const guessed = await createEntityFixture(page, "vendor", {
    name: guessedName,
  });
  const other = await createEntityFixture(page, "vendor", {
    name: otherName,
  });
  const names = [`${prefix} set by Cubby`, `${prefix} still open`];
  const products = await Promise.all(
    names.map((name) => createEntityFixture(page, "product", { name })),
  );
  const [setProduct, openProduct] = products;
  if (!setProduct || !openProduct)
    throw new Error("Synthetic Products are missing");
  const [setId, openId, guessedId, otherId] = await Promise.all([
    resolveOrThrow(db, "product", setProduct.id),
    resolveOrThrow(db, "product", openProduct.id),
    resolveOrThrow(db, "vendor", guessed.id),
    resolveOrThrow(db, "vendor", other.id),
  ]);
  const runId = await ensureRun(db, actor, { purpose: "ai_suggest" });
  await drainDerivedRefreshFrontier(db);
  const seed = (
    recordId: string,
    confidence: number,
    runnerUp: { value: string; confidence: number } | null,
  ) =>
    seedFieldSuggestion(db, {
      runId,
      entity: "product",
      recordId,
      field: "brandId",
      currentValue: null,
      suggestedValue: guessed.id,
      confidence,
      runnerUpValue: runnerUp?.value ?? null,
      runnerUpConfidence: runnerUp?.confidence ?? null,
      model: "typesafe/jev",
      kind: "addition",
      status: "pending",
    });
  const automatic = await seed(setId, 0.97, null);
  await applyFieldAnswerFixture(db, automatic);
  await seed(openId, 0.62, { value: other.id, confidence: 0.21 });
  const brandOf = (id: string) => async () =>
    (
      await getDb(db)
        .select({ brandId: productTable.brandId })
        .from(productTable)
        .where(eq(productTable.id, parseEntityId("product", id)))
    )[0]?.brandId ?? null;

  // One saved state: Cubby's value is a plain value with no automatic mark.
  await gotoAuthenticatedPage(page, `/products/${setProduct.id}`);
  await expect(
    page.getByText(guessedName, { exact: true }).first(),
  ).toBeVisible();
  await expect(page.getByLabel("Set automatically")).toHaveCount(0);

  // Editing Cubby's value is an ordinary edit; the server records the Miss.
  await page.getByRole("button", { name: "Edit vendor", exact: true }).click();
  await page.keyboard.type(otherName);
  await page.getByRole("option", { name: new RegExp(`^${otherName}`) }).click();
  await expect.poll(brandOf(setId)).toBe(otherId);
  await page.reload();
  await waitForAppHydration(page);
  await expect(
    page.getByText(otherName, { exact: true }).first(),
  ).toBeVisible();

  // The empty field's picker lists Cubby's guess first, never selected.
  await gotoAuthenticatedPage(page, `/products/${openProduct.id}`);
  await expect(page.getByText(guessedName, { exact: true })).toHaveCount(0);
  // An absent key fact folds under the side column's not-recorded list.
  await openFoldedFacts(
    page.getByRole("region", { name: "Key facts" }),
    "Brand",
  );
  await page.getByRole("button", { name: "Edit vendor", exact: true }).click();
  const guess = page.getByRole("option", {
    name: /Cubby's guess, 62% sure/,
  });
  await expect(guess).toBeVisible();
  await expect(guess).toHaveAttribute("aria-selected", "false");
  await expect(
    page.getByRole("option", { name: /Cubby's guess, 21% sure/ }),
  ).toBeVisible();
  // With an empty search, Enter picks Cubby's guess.
  await page.keyboard.press("Enter");
  await expect.poll(brandOf(openId)).toBe(guessedId);
});

// Prune acceptance acknowledges the remaining saved tags, not the removed token.
test("prunes real Product tags and records saved Feedback and its receipt", async ({
  page,
}, testInfo) => {
  const { db, actor } = await createEvidenceHarnessContext(page);
  const name = uniqueName(testInfo, "Prune receipt");
  const product = await seedProductPrerequisite(page, {
    name,
    brandName: "Synthetic brand",
    tags: ["synthetic-brand", "ecosystem", "mount"],
  });
  const id = await resolveOrThrow(db, "product", product.id);
  const runId = await ensureRun(db, actor, { purpose: "ai_suggest" });
  const removals = [
    {
      value: "synthetic-brand",
      probability: 0.99,
      reason: "Restates brandName",
    },
  ];
  const prediction = await publishExactSuggestion(
    db,
    {
      publicationKey: `synthetic:prune:${id}`,
      family: "field",
      subject: {
        kind: "field",
        entity: "product",
        recordId: id,
        field: "tags",
      },
      judgment: { value: "synthetic-brand", operation: "remove", removals },
      fingerprint: null,
      producer: null,
      evidence: null,
    },
    // A confident removal from populated tags, as a refresh publishes it.
    {
      runId,
      confidence: 0.99,
      kind: "correction",
      // A stored removal proposes the remaining entries, as a Sweep saves it.
      currentValue: ["synthetic-brand", "ecosystem", "mount"],
      suggestedValue: ["ecosystem", "mount"],
      data: {
        liveInputFingerprint: await fieldInputFingerprint(
          db,
          "product",
          id,
          "tags",
        ),
      },
    },
  );
  // The detail fact lists the stored proposal beneath the field.
  await gotoAuthenticatedPage(page, `/products/${product.id}`);
  await page
    .getByText("Tags", { exact: true })
    .first()
    .scrollIntoViewIfNeeded();
  await expect(page.getByText("Cubby would remove")).toBeVisible({
    timeout: 15_000,
  });
  await page.getByRole("button", { name: /^Remove synthetic-brand/ }).click();
  await expect
    .poll(
      async () =>
        (
          await getDb(db)
            .select({ tags: productTable.tags })
            .from(productTable)
            .where(eq(productTable.id, id))
        )[0]?.tags,
    )
    .toEqual(["ecosystem", "mount"]);
  const events = await readSuggestionDecisions(db, prediction.id);
  expect(events).toContainEqual(
    expect.objectContaining({
      verdict: "correct",
      intent: "apply",
      authority: "member",
    }),
  );
});
