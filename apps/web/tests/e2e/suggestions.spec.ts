import { seedProductPrerequisite } from "./fixtures/catalog";
import { seedFieldSuggestion } from "tooling/shared-suggestion-fixtures";
import { fieldSuggestionsReply } from "./support/field-suggestion-wire";
import { buildCrudServices } from "~/server/http/request-context";
import { fieldInputFingerprint } from "~/server/generic/suggestions/repo/field-input-fence";
import { drainDerivedRefreshFrontier } from "~/server/testing/background-queue";
import type { Page } from "@playwright/test";
import { suggestionReviewInput } from "@cubby/schemas/suggestion";
import {
  recordSourceTransactionRecordsOut,
  recordSourceTransactionRecordsInput,
  type SourceTransactionRecordInput,
} from "@cubby/schemas/source-transaction-record";
import { eq, sql } from "drizzle-orm";
import { financialSpendingAdvice } from "@cubby/schemas/financial-booking";
import { labelStatementSuggestions } from "~/server/domains/transaction-import/service/statement-suggestion-labels";
import { answering } from "~/server/domains/transaction-import/repo/statement-decision-port.fixtures";
import { recordSourceTransactionRecords } from "~/server/domains/transaction-import/repo/source-transaction-record";
import { z } from "zod";

import { BROWSER_OPERATION_PATH } from "~/lib/browser-operation-path";
import { product as productTable } from "~/server/db/schema";

import { ensureRun } from "~/server/domains/run/repo/ensure-run";
import { generateStatementSuggestionPage } from "~/server/domains/transaction-import/repo/statement-suggestions";
import { publishSuggestion } from "~/server/generic/suggestions/repo/suggestion";
import { getDb } from "~/server/db/helpers";
import { resolveOrThrow } from "~/server/generic/shortcode/repo/shortcode-resolver";
import { readSuggestionDecisions } from "~/server/testing/suggestion-decisions.fixtures";

import { dispatchesOperation, unbatchFor } from "./support/dispatch-wire";
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

// Failure modes: a family drops out of the page; a record renders as a bare
// shortcode or a category as the generic grey reference chip; Accept on a
// field or Confirm on a connection writes nothing.
test("Suggestions lists every family with named records and category pills, and reviews fields", async ({
  page,
}, testInfo) => {
  const { db, actor } = await createEvidenceHarnessContext(page);
  const categoryName = uniqueName(testInfo, "Suggested category");
  const category = await createEntityFixture(page, "productCategory", {
    name: categoryName,
  });
  const productName = uniqueName(testInfo, "Suggested drill");
  const item = await createEntityFixture(page, "product", {
    name: productName,
    categoryId: null,
  });
  const itemId = await resolveOrThrow(db, "product", item.id);
  const runId = await ensureRun(db, actor, { purpose: "ai_suggest" });

  const alias = uniqueName(testInfo, "Suggestions card");
  await createEntityFixture(page, "financialAccount", {
    name: alias,
    identity: { kind: "credit_card", network: "visa" },
    sourceAliases: [{ source: "monarch", alias, externalAccountId: null }],
  });
  const importId = await recordRows(
    page,
    alias,
    db,
  )(alias, [
    {
      statementDate: "2026-05-11",
      providerAmount: -17.25,
      rawDescription: `${alias} CAFE`,
    },
  ]);
  await generateStatementSuggestions(db, importId);
  await drainDerivedRefreshFrontier(db);
  const seedCategoryAdvice = async () =>
    seedFieldSuggestion(
      db,
      {
        runId,
        entity: "product",
        recordId: itemId,
        field: "categoryId",
        currentValue: null,
        suggestedValue: category.id,
        confidence: 0.91,
        runnerUpValue: null,
        runnerUpConfidence: null,
        model: "typesafe/jev",
        kind: "addition",
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
  await gotoAuthenticatedPage(page, "/suggestions");
  const families = page.getByRole("group", { name: "Suggestion families" });
  for (const family of ["Statements", "Fields"])
    await expect(
      families.getByRole("button", { name: new RegExp(`^${family} [1-9]`) }),
    ).toBeVisible();

  // A record's Suggestions list under it, in the All view.
  await gotoAuthenticatedPage(page, `/suggestions?record=product:${item.id}`);
  const rows = suggestionsTable(page).getByRole("row");
  const field = rows
    .filter({ hasText: "Field" })
    .filter({ hasText: "Category" });
  await expect(field).toHaveCount(1);
  const recordLink = field.getByRole("link", { name: productName });
  await expect(recordLink).toBeVisible();
  // The category retains its full-path record label.
  await expect(
    field.locator(`a[href="/product-categories/${category.id}"]`),
  ).toContainText(categoryName);

  // Exclusion survives route validation and a reload, and the shared editor
  // can clear it without losing the scoped proposal.
  // SSR can supply the scoped read; membership must not depend on a second RPC.
  await gotoAuthenticatedPage(
    page,
    `/suggestions?family=field&record=product:${item.id}&entityExclude=product`,
  );
  await expect(
    page.getByText("No pending suggestions.", { exact: true }),
  ).toBeVisible();
  await expect(
    suggestionsTable(page).getByRole("link", { name: productName }),
  ).toHaveCount(0);
  await page.reload();
  await waitForAppHydration(page);
  await expect(page.getByText("__not__:product", { exact: true })).toHaveCount(
    0,
  );
  await page.getByRole("button", { name: "Filters", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: /^Entity:/ })
    .click();
  await expect(
    page.getByLabel("Entity is or is not", { exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await page
    .getByRole("button", { name: "Clear Entity filter", exact: true })
    .click();
  await expect(
    suggestionsTable(page).getByRole("link", { name: productName }),
  ).toBeVisible();
  await gotoAuthenticatedPage(page, `/suggestions?record=product:${item.id}`);

  // The shared workbench must clear selected actions when server sort swaps
  // the query, without applying or dismissing the selected proposal.
  await field
    .getByRole("checkbox", { name: "Select row", exact: true })
    .check();
  const selected = page.getByRole("region", {
    name: "Selected rows",
    exact: true,
  });
  await expect(selected).toBeVisible();
  await selected.getByRole("button", { name: "More", exact: true }).click();
  await expect(
    page.getByRole("menuitem", { name: /^Never suggest/ }),
  ).toBeDisabled();
  await page.keyboard.press("Escape");
  await page.getByRole("combobox", { name: "Sort", exact: true }).click();
  await page.getByRole("option", { name: "Most impact", exact: true }).click();
  await expect(selected).toHaveCount(0);
  await expect(
    field.getByRole("checkbox", { name: "Select row", exact: true }),
  ).not.toBeChecked();

  await drainDerivedRefreshFrontier(db);
  await gotoAuthenticatedPage(page, `/suggestions?record=product:${item.id}`);
  await expect(field).toHaveCount(1);
  expect(
    (
      await getDb(db)
        .select({ categoryId: productTable.categoryId })
        .from(productTable)
        .where(eq(productTable.id, itemId))
    )[0]?.categoryId,
  ).toBeNull();
  await field.getByRole("button", { name: "Accept", exact: true }).click();
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

// Acceptance must acknowledge the chosen value before the response arrives,
// retain other pills throughout the write/refetch, and persist the real value.
test("list pills accept immediately without unloading another row's suggestion", async ({
  page,
}, testInfo) => {
  const { db, actor } = await createEvidenceHarnessContext(page);
  const categoryName = uniqueName(testInfo, "Pill category");
  const category = await createEntityFixture(page, "productCategory", {
    name: categoryName,
  });
  const prefix = uniqueName(testInfo, "Pill lifecycle");
  const names = [`${prefix} first`, `${prefix} second`];
  const products = await Promise.all(
    names.map((name) =>
      createEntityFixture(page, "product", { name, categoryId: null }),
    ),
  );
  const recordIds = await Promise.all(
    products.map((product) => resolveOrThrow(db, "product", product.id)),
  );
  const firstRecordId = recordIds[0];
  if (!firstRecordId) throw new Error("Synthetic first Product is missing");
  const runId = await ensureRun(db, actor, { purpose: "ai_suggest" });
  await drainDerivedRefreshFrontier(db);
  await Promise.all(
    recordIds.map(async (recordId) =>
      seedFieldSuggestion(
        db,
        {
          runId,
          entity: "product",
          recordId,
          field: "categoryId",
          currentValue: null,
          suggestedValue: category.id,
          confidence: 0.97,
          runnerUpValue: null,
          runnerUpConfidence: null,
          model: "typesafe/jev",
          kind: "addition" as const,
          status: "pending" as const,
          data: {
            liveInputFingerprint: await fieldInputFingerprint(
              db,
              "product",
              recordId,
              "categoryId",
            ),
          },
        },
        true,
      ),
    ),
  );
  const acceptance = Promise.withResolvers<void>();
  await page.route(`**${BROWSER_OPERATION_PATH}/*`, async (route) => {
    if (
      !dispatchesOperation(
        route.request(),
        "suggestion.review",
        (item) =>
          suggestionReviewInput.safeParse(item.input).data?.intent === "apply",
      )
    ) {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    await acceptance.promise;
    await route.fulfill({ response });
  });
  await gotoAuthenticatedPage(
    page,
    `/products?searchQuery=${encodeURIComponent(prefix)}`,
  );
  const table = page.getByRole("table", { name: /Products table/i });
  const first = table.getByRole("row").filter({ hasText: names[0] });
  const second = table.getByRole("row").filter({ hasText: names[1] });
  const pillName = `Accept suggested value: ${categoryName}`;
  await expect(first.getByRole("button", { name: pillName })).toBeEnabled();
  await expect(second.getByRole("button", { name: pillName })).toBeEnabled();
  // This journey guards acknowledgement and row continuity. Give the category
  // a readable width through the real resize control before accepting it.
  const header = table.locator('th[data-column-id="categoryId"]');
  const grip = await header
    .getByTitle("Drag to resize · double-click to reset")
    .boundingBox();
  if (!grip) throw new Error("Category resize control is not rendered");
  const x = grip.x + grip.width / 2;
  const y = grip.y + grip.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 200, y, { steps: 8 });
  await page.mouse.up();
  await expect
    .poll(async () => (await header.boundingBox())?.width ?? 0)
    .toBeGreaterThan(180);
  await first.getByRole("button", { name: pillName }).click();
  await expect(first.getByRole("button", { name: pillName })).toHaveCount(0);
  await expect(first.getByText(categoryName, { exact: true })).toBeVisible();
  await expect(
    first.getByRole("status", { name: "Saving suggested value" }),
  ).toBeVisible();
  await expect(second.getByRole("button", { name: pillName })).toBeEnabled();
  await expect
    .poll(
      async () =>
        (
          await getDb(db)
            .select({ categoryId: productTable.categoryId })
            .from(productTable)
            .where(eq(productTable.id, firstRecordId))
        )[0]?.categoryId,
    )
    .toBe(await resolveOrThrow(db, "productCategory", category.id));
  acceptance.resolve();
  await expect(
    first.getByRole("status", { name: "Saving suggested value" }),
  ).toHaveCount(0);
  await expect(first.getByText(categoryName, { exact: true })).toBeVisible();
  await expect(second.getByRole("button", { name: pillName })).toBeEnabled();
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
    { active: false, runId },
  );
  await page.route(`**${BROWSER_OPERATION_PATH}/*`, async (route) => {
    if (await unbatchFor(route, ["ai.suggestFields", "ai.suggestFieldsBatch"]))
      return;
    if (
      !dispatchesOperation(route.request(), "ai.suggestFields") &&
      !dispatchesOperation(route.request(), "ai.suggestFieldsBatch")
    )
      return route.continue();
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        data: fieldSuggestionsReply(route.request(), {
          suggestions: {
            tags: {
              suggestionId: prediction.id,
              value: "synthetic-brand",
              label: "Remove synthetic-brand",
              confidence: "high",
              probability: 0.99,
              detail: "Restates brandName",
              reasoning: "Synthetic retained pruning",
              alternatives: [],
              operation: "remove",
              removals,
            },
          },
        }),
      }),
    });
  });
  // Pruning is an explicit record evaluation; published-only tables do not
  // generate transient field proposals.
  await gotoAuthenticatedPage(page, `/products/${product.id}`);
  await expect(page.getByText(/^Remove synthetic-brand/)).toBeVisible();
  await page.getByRole("button", { name: "Accept", exact: true }).click();
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
  await expect
    .poll(
      async () =>
        (await readSuggestionDecisions(db, prediction.id)).filter((event) =>
          event.operationId.startsWith("receipt:"),
        ).length,
    )
    .toBe(1);
  const events = await readSuggestionDecisions(db, prediction.id);
  expect(events).toContainEqual(
    expect.objectContaining({
      verdict: "correct",
      intent: "apply",
      authority: "member",
    }),
  );
  expect(
    events.find((event) => event.operationId.startsWith("receipt:"))?.receipt,
  ).toEqual(
    expect.objectContaining({ mode: "member", reason: "member_acceptance" }),
  );
});
