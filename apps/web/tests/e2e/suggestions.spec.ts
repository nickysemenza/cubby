import { seedProductPrerequisite } from "./fixtures/catalog";
import {
  seedFieldSuggestion,
  stampCurrentFieldProvenance,
} from "tooling/shared-suggestion-fixtures";
import { buildCrudServices } from "~/server/http/request-context";
import { fieldInputFingerprint } from "~/server/generic/suggestions/repo/field-input-fence";
import { drainDerivedRefreshFrontier } from "~/server/testing/background-queue";
import type { Page } from "@playwright/test";
import {
  recordSourceTransactionRecordsOut,
  recordSourceTransactionRecordsInput,
  type SourceTransactionRecordInput,
} from "@cubby/schemas/source-transaction-record";
import { parseEntityId } from "@cubby/schemas/identifiers";
import { eq, sql } from "drizzle-orm";
import { financialSpendingAdvice } from "@cubby/schemas/financial-booking";
import { labelStatementSuggestions } from "~/server/domains/transaction-import/service/statement-suggestion-labels";
import { answering } from "~/server/domains/transaction-import/repo/statement-decision-port.fixtures";
import { recordSourceTransactionRecords } from "~/server/domains/transaction-import/repo/source-transaction-record";
import { z } from "zod";

import { product as productTable } from "~/server/db/schema";

import { ensureRun } from "~/server/domains/run/repo/ensure-run";
import { generateStatementSuggestionPage } from "~/server/domains/transaction-import/repo/statement-suggestions";
import { publishSuggestion } from "~/server/generic/suggestions/repo/suggestion";
import { getDb } from "~/server/db/helpers";
import { resolveOrThrow } from "~/server/generic/shortcode/repo/shortcode-resolver";
import { applyAutomaticRules } from "~/server/generic/suggestions/repo/automatic-application";
import { readSuggestionDecisions } from "~/server/testing/suggestion-decisions.fixtures";

import { dispatchesOperation } from "./support/dispatch-wire";
import {
  gotoAuthenticatedPage,
  uniqueName,
  waitForAppHydration,
} from "./support/e2e-helpers";
import { expect, test } from "./support/e2e-test";
import { operationCall } from "./support/operation";
import {
  createEntityFixture,
  createFixtureGraph,
  createEvidenceHarnessContext,
  ensureMemberParty,
} from "./fixtures/core";

type Db = Awaited<ReturnType<typeof createEvidenceHarnessContext>>["db"];

/** Keep a scenario's generation independent of earlier imports in its worker database. */
async function generateStatementSuggestions(db: Db, importId: string) {
  let after: Parameters<typeof generateStatementSuggestionPage>[1]["after"] =
    null;
  for (;;) {
    const page = await generateStatementSuggestionPage(db, {
      servicesFor: buildCrudServices,
      after,
      runId: null,
      scope: { importId },
    });
    if (!page.next) return;
    after = page.next;
  }
}

/** Synthetic Monarch rows on one account alias. */
const recordRows =
  (page: Page, alias: string, db: Db) =>
  async (
    fingerprint: string,
    rows: Partial<SourceTransactionRecordInput>[],
  ) => {
    const response = await operationCall(
      page.request,
      "sourceTransactionRecord.record",
      {
        import: {
          source: "monarch",
          label: `${fingerprint}.csv`,
          fingerprint,
          dateKind: "posted",
        },
        rows: rows.map((row, index) => ({
          accountDescriptor: alias,
          merchant: null,
          providerStatus: "posted",
          sourceCategory: null,
          rowPosition: index + 1,
          ...row,
        })),
      },
    );
    expect(response.ok(), await response.text()).toBe(true);
    const receipt = recordSourceTransactionRecordsOut.parse(response.body);
    if (!receipt.batchId) throw new Error("Transaction import missing");
    return resolveOrThrow(db, "transactionImport", receipt.batchId);
  };

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
test("statement Suggestions attach to a named candidate, bulk-accept a clean supersede and dismiss", async ({
  page,
}, testInfo) => {
  test.slow();
  const { db, actor } = await createEvidenceHarnessContext(page);
  const alias = uniqueName(testInfo, "Statement card");
  const owner = await ensureMemberParty(page, alias);
  const { category, account, recorded } = await createFixtureGraph(
    page,
    async (create) => {
      const category = await create("spendingCategory", {
        name: `${alias} spending`,
      });
      const account = await create("financialAccount", {
        name: alias,
        ledgerPartyId: owner.shortcode,

        identity: { kind: "credit_card", network: "visa" },
        sourceAliases: [{ source: "monarch", alias, externalAccountId: null }],
      });
      const recorded = await create("financialTransaction", {
        accountId: account.id,
        amount: 61.07,
        merchant: `${alias} Hardware`,
        kind: "purchase",
        status: "pending",
        transactionDate: "2026-05-11",
      });
      return { category, account, recorded };
    },
  );
  const labelSpending = () =>
    labelStatementSuggestions(db, {
      port: answering({ kind: "purchase", counterparty: "business" }),
      spendingAdvice: async ({ judgment }) =>
        financialSpendingAdvice.parse({
          spendingCategoryId: category.id,
          categoryConfidence: "high",
          vendorName: judgment.create?.rawDescription,
          vendorConfidence: "high",
          counterparty: "business",
        }),
    });
  const accountId = await resolveOrThrow(db, "financialAccount", account.id);
  const spendingTotal = async () => {
    const spent = await getDb(db).execute<{ total: number }>(sql`
      SELECT coalesce(sum(e.cost),0)::float8 AS total FROM "Expense" e WHERE e."deletedAt" IS NULL
        AND e."purchaseId" IN (SELECT a."purchaseId" FROM "FinancialTransactionAllocation" a
          JOIN "FinancialTransaction" f ON f.id=a."transactionId" WHERE f."accountId"=${accountId} AND a."deletedAt" IS NULL)
    `);
    return spent.rows[0]?.total;
  };
  const hardware = `${alias} HARDWARE 0441`;
  const hold = `${alias} HOLD`;
  const cafe = `${alias} CAFE`;
  const record = recordRows(page, alias, db);
  const importId = await record(alias, [
    {
      statementDate: "2026-05-12",
      providerAmount: -61.07,
      rawDescription: hardware,
      sourceCategory: "Shopping",
    },
    {
      // Category evidence makes pending spending bookable after labeling.
      statementDate: "2026-05-04",
      providerAmount: -42.5,
      rawDescription: hold,
      sourceCategory: "Groceries",
      providerStatus: "pending",
    },
    {
      // No category: only the sign speaks to the kind, so it needs review.
      statementDate: "2026-05-11",
      providerAmount: -17.25,
      rawDescription: cafe,
    },
  ]);
  await generateStatementSuggestions(db, importId);

  const view = `/suggestions?family=statement_transaction&record=financialAccount:${account.id}&group=account_month`;
  const table = suggestionsTable(page);
  const rowFor = (text: string) =>
    table.getByRole("row").filter({ hasText: text });
  await labelSpending();
  await gotoAuthenticatedPage(page, view);
  await rowFor(hardware)
    .getByRole("button", { name: "More review choices" })
    .click();
  await expect(
    page.getByRole("menuitem", { name: "Change kind…" }),
  ).toHaveCount(0);
  await page.getByRole("menuitem", { name: "Preview new transaction" }).click();
  await expect(
    page.getByRole("combobox", { name: "Transaction kind" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Use recommendation" }).click();
  // The attach names its candidate in the review it sends.
  await expect(
    page.getByRole("list", { name: "Candidate transactions" }),
  ).toContainText("61.07");
  // Pending evidence already supports booking. Applying attested posted status
  // remains a reviewed choice and must preserve the ready graph and draft.
  const result = page.getByRole("region", {
    name: "Proposed result",
    exact: true,
  });
  await expect(result).toContainText("One Purchase and one lump Expense");
  await expect(
    page.getByText("Updating spending preview…", { exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("checkbox", { name: "Apply status", exact: true })
    .check();
  // Preview the graph, including auto-created identity and no vendor account.
  await expect(result).toContainText("One Purchase and one lump Expense");
  await expect(result).toContainText("Create vendor");
  await expect(result).toContainText("Unassigned");
  await expect(result).toContainText("Recorded spending");
  await result
    .getByRole("button", { name: "Correct booking", exact: true })
    .click();
  const reviewedVendor = `${alias} Reviewed Hardware`;
  await result
    .getByRole("textbox", { name: "Reviewed new Vendor business name" })
    .fill(" ");
  await expect(
    result.getByRole("textbox", { name: "Reviewed new Vendor business name" }),
  ).toBeVisible();
  await result
    .getByRole("textbox", { name: "Reviewed new Vendor business name" })
    .fill(reviewedVendor);
  await expect(result).toContainText(`Create vendor “${reviewedVendor}”`);
  await expect(
    result.getByRole("textbox", { name: "Reviewed new Vendor business name" }),
  ).toBeFocused();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(result).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.setViewportSize({ width: 1440, height: 900 });

  const attach = page.waitForRequest((request) =>
    dispatchesOperation(
      request,
      "suggestion.reviewBatch",
      (item) =>
        z
          .object({
            items: z.array(
              z.object({
                application: z.object({
                  action: z.literal("attach"),
                  transactionId: z.literal(recorded.id),
                }),
              }),
            ),
          })
          .safeParse(item.input).success,
    ),
  );
  await rowFor(hardware)
    .getByRole("button", { name: "Accept", exact: true })
    .click();
  await attach;
  await expect(rowFor(hardware)).toHaveCount(0);

  await rowFor(hold)
    .getByRole("button", { name: "Accept", exact: true })
    .click();
  await expect(rowFor(hold)).toHaveCount(0);
  expect(await spendingTotal()).toBe(103.57);

  // The preceding acceptance commits search work before the row disappears.
  // Settle that work before this serializable fixture import updates the same
  // refresh Job; the offline pump can otherwise change it under our snapshot.
  await drainDerivedRefreshFrontier(db);
  // Publish manual review work without scheduling import-clean execution,
  // which would legitimately finish the same booking before the bulk click.
  const posted = await recordSourceTransactionRecords(
    db,
    recordSourceTransactionRecordsInput.parse({
      import: {
        source: "monarch",
        label: "synthetic-posted.csv",
        fingerprint: `${alias}-posted`,
        dateKind: "posted",
      },
      rows: [
        {
          accountDescriptor: alias,
          statementDate: "2026-05-06",
          providerAmount: -42.5,
          rawDescription: `${alias} GROCER`,
          sourceCategory: "Groceries",
          providerStatus: "posted",
          rowPosition: 1,
        },
      ],
    }),
    actor,
  );
  // Reviewed supersession must preserve the already-booked pending spending.
  if (!posted.batchId)
    throw new Error("Synthetic posted statement import was not saved");
  await generateStatementSuggestions(db, posted.batchId);
  await labelSpending();
  await gotoAuthenticatedPage(page, view);
  await page.getByRole("button", { name: "Accept 1 clean" }).click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Accept 1" })
    .click();
  await expect(page.getByText(/Accepted 1 of 1/)).toBeVisible();
  await expect(
    page.getByRole("list", { name: "Failed suggestions" }),
  ).toHaveCount(0);

  expect(await spendingTotal()).toBe(103.57);

  await rowFor(cafe)
    .getByRole("button", { name: "Dismiss", exact: true })
    .click();
  await expect(rowFor(cafe)).toHaveCount(0);
});

// Failure mode: Find suggestions starts a Sweep without showing what it will
// read, or the Sweep it starts has no visible Steps.
test("Find suggestions estimates a Sweep before it starts, then follows its Steps", async ({
  page,
}, testInfo) => {
  // Sweeps are member work: the login needs its member party.
  await ensureMemberParty(page, uniqueName(testInfo, "Sweep member"));
  await gotoAuthenticatedPage(page, "/suggestions");
  await page.getByRole("button", { name: "Find suggestions…" }).click();
  const dialog = page.getByRole("dialog", { name: "Find suggestions" });
  for (const family of ["Fields"])
    await dialog.getByRole("checkbox", { name: family }).click();
  const estimate = dialog.getByRole("list", { name: "Sweep estimate" });
  await expect(estimate).toContainText("Statements");
  // The estimate counts what each family's first step reads.
  await expect(estimate).toContainText(/\d+ charges?/);
  await dialog.getByRole("button", { name: "Start Sweep" }).click();
  const status = page.getByLabel("Sweep status");
  await expect(status).toBeVisible();
  await status.getByRole("link").first().click();
  await expect(page).toHaveURL(/\/runs\/RUN-/);
  await page.locator("section#steps").scrollIntoViewIfNeeded();
  await expect(
    page.getByRole("heading", { name: "Execution steps", exact: true }),
  ).toBeVisible();
});

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
  await stampCurrentFieldProvenance(db, automatic, "product", "brandId");
  const applied = await applyAutomaticRules(db, [automatic.id], {
    context: buildCrudServices,
  });
  expect(applied.applied).toHaveLength(1);
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
  const prediction = await publishSuggestion(
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
