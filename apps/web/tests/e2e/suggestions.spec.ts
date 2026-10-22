import { publishFieldAssessment } from "~/server/generic/assessment/repo/assessment";
import { fieldSuggestionsReply } from "./support/field-suggestion-wire";
import { fieldInputFingerprint } from "~/server/generic/assessment/repo/field-input-fence";
import { drainDerivedRefreshFrontier } from "~/server/testing/background-queue";
import type { Page } from "@playwright/test";
import superjson from "superjson";
import { settledSuggestionQuestionsInput } from "@cubby/schemas/ai";
import { assessmentReviewInput } from "@cubby/schemas/assessment";
import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import {
  recordStatementRowsOut,
  listStatementRowsInput,
  recordStatementRowsInput,
  type StatementRowInput,
} from "@cubby/schemas/statement-row";
import { eq, sql } from "drizzle-orm";
import { financialSpendingAdvice } from "@cubby/schemas/financial-booking";
import { labelStatementSuggestions } from "~/server/domains/statement-import/service/statement-suggestion-labels";
import { answering } from "~/server/domains/statement-import/repo/statement-decision-port.fixtures";
import {
  recordStatementRows,
  updateStatementRows,
} from "~/server/domains/statement-import/repo/statement-row";
import { z } from "zod";

import { shiftPlainDate } from "~/lib/household-date";
import { BROWSER_OPERATION_PATH } from "~/lib/browser-operation-path";
import { user } from "~/server/db/auth.schema";
import { product as productTable, feedback } from "~/server/db/schema";
import {
  publishEntityConnection,
  readEntityConnections,
} from "~/server/domains/connection/repo/entity-connections";
import { ensureRun } from "~/server/domains/run/repo/ensure-run";
import { generateStatementSuggestionPage } from "~/server/domains/statement-import/repo/statement-suggestions";
import { publishAssessment } from "~/server/generic/assessment/repo/assessment";
import { getDb } from "~/server/db/helpers";
import { resolveOrThrow } from "~/server/generic/shortcode/repo/shortcode-resolver";

import {
  dispatchesOperation,
  dispatchOperations,
  unbatchFor,
} from "./support/dispatch-wire";
import {
  gotoAuthenticatedPage,
  readExpense,
  uniqueName,
} from "./support/e2e-helpers";
import { expect, test } from "./support/e2e-test";
import { startOperation } from "./support/start-operation";
import {
  createEntityFixture,
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
      after,
      runId: null,
      scope: { importId },
    });
    if (!page.next) return;
    after = page.next;
  }
}

/**
 * The reserved system user an import's routine Sweep runs as. Production
 * has it; a fresh E2E database does not.
 */
// TODO(#2722): seed the system user in the E2E base world instead.
async function ensureSystemUser(db: Db) {
  await getDb(db)
    .insert(user)
    .values({
      id: "cubby-system",
      name: "Cubby",
      email: "cubby-system@example.invalid",
    })
    .onConflictDoNothing();
}

/** Synthetic Monarch rows on one account alias. */
const recordRows =
  (page: Page, alias: string) =>
  async (fingerprint: string, rows: Partial<StatementRowInput>[]) => {
    const response = await startOperation(page.request, "statementRow.record", {
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
    });
    expect(response.ok(), await response.text()).toBe(true);
    return recordStatementRowsOut
      .extend({ batchId: z.string() })
      .parse(response.body).batchId;
  };

const suggestionsTable = (page: Page) =>
  page.getByRole("table", { name: "Suggestions" });

// Failure: an evaluated empty category looks like an unexplained dash, or its
// explanation can only be reached with a mouse.
test("empty suggestion cells expose an abstention and keyboard-accessible details", async ({
  page,
}, testInfo) => {
  const name = uniqueName(testInfo, "Unclassified tool");
  await createEntityFixture(page, "product", { name, categoryId: null });
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
      body: JSON.stringify(
        superjson.serialize({
          ok: true,
          data: fieldSuggestionsReply(route.request(), {
            suggestions: {},
            outcomes: {
              categoryId: {
                kind: "evaluated",
                answer: "none",
                confidence: "high",
                probability: 0.98,
                alternatives: [],
              },
            },
          }),
        }),
      ),
    });
  });
  await gotoAuthenticatedPage(
    page,
    `/products?searchQuery=${encodeURIComponent(name)}`,
  );
  const row = page
    .getByRole("row")
    .filter({ has: page.getByRole("link", { name, exact: true }) });
  const category = row.locator('[data-cell-col="categoryId"]');
  const status = category.getByRole("button", { name: /No good fit/ });
  await expect(status).toBeVisible();
  await expect(status).toHaveText("No good fit");
  await status.focus();
  await expect(status).toBeFocused();
  await status.press("Enter");
  await expect(
    page.getByText("No good fit · 98% · high", { exact: true }),
  ).toBeVisible();
});

// A saved answer must remain readable during revalidation without permitting
// an old proposal to write. The current answer must replace it when it arrives.
test("saved suggestion previews stay visible while current evidence is checked", async ({
  page,
}, testInfo) => {
  const name = uniqueName(testInfo, "Cached suggestion tool");
  const categoryName = uniqueName(testInfo, "Cached category");
  const category = await createEntityFixture(page, "productCategory", {
    name: categoryName,
  });
  await createEntityFixture(page, "product", { name, categoryId: null });
  const live = Promise.withResolvers<void>();
  const proposal = {
    value: category.id,
    label: "Synthetic saved category",
    detail: null,
    confidence: "high",
    probability: 0.97,
    reasoning: "Synthetic saved evidence",
    alternatives: [],
  };
  await page.route(`**${BROWSER_OPERATION_PATH}/*`, async (route) => {
    if (
      await unbatchFor(route, [
        "ai.suggestFields",
        "ai.suggestFieldsBatch",
        "ai.settledSuggestionQuestions",
      ])
    )
      return;
    const [operation] = dispatchOperations(route.request());
    if (operation?.operation === "ai.settledSuggestionQuestions") {
      const input = settledSuggestionQuestionsInput.parse(operation.input);
      if (input.read !== "preview") await live.promise;
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(
          superjson.serialize({
            ok: true,
            data: {
              results: input.questions.map(({ field }) => ({
                ok: true,
                value: {
                  outcome: null,
                  revision: null,
                  preview:
                    input.read === "preview" && field === "categoryId"
                      ? {
                          suggestion: proposal,
                          outcome: {
                            kind: "evaluated",
                            answer: "pick",
                            confidence: "high",
                            probability: 0.97,
                            alternatives: [],
                          },
                        }
                      : null,
                },
              })),
            },
          }),
        ),
      });
      return;
    }
    if (
      operation?.operation !== "ai.suggestFields" &&
      operation?.operation !== "ai.suggestFieldsBatch"
    )
      return route.continue();
    await live.promise;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(
        superjson.serialize({
          ok: true,
          data: fieldSuggestionsReply(route.request(), {
            suggestions: {},
            outcomes: {
              categoryId: {
                kind: "evaluated",
                answer: "none",
                confidence: "high",
                probability: 0.98,
                alternatives: [],
              },
            },
          }),
        }),
      ),
    });
  });
  try {
    await gotoAuthenticatedPage(
      page,
      `/products?searchQuery=${encodeURIComponent(name)}`,
    );
    const row = page
      .getByRole("row")
      .filter({ has: page.getByRole("link", { name, exact: true }) });
    const cell = row.locator('[data-cell-col="categoryId"]');
    // Reference previews resolve the stored category name, which can replace
    // the model's cached label before this assertion runs.
    const saved = cell.getByRole("button", {
      name: `Accept suggested value: ${categoryName}`,
      exact: true,
    });
    await expect(saved).toBeVisible();
    await expect(saved).toBeDisabled();
    live.resolve();
    await expect(
      cell.getByRole("button", { name: /No good fit/ }),
    ).toBeVisible();
    await expect(saved).toHaveCount(0);
  } finally {
    live.resolve();
  }
});

// Failure modes: a family drops out of the page; a record renders as a bare
// shortcode or a category as the generic grey reference chip; Accept on a
// field or Confirm on a connection writes nothing.
test("Suggestions lists every family with named records and category pills, and reviews fields and connections", async ({
  page,
}, testInfo) => {
  const { db, actor } = await createEvidenceHarnessContext(page);
  await ensureSystemUser(db);
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

  const charge = await createEntityFixture(page, "expense", {
    name: productName,
    cost: 24,
    productId: null,
    trade: "electrical",
  });
  await publishEntityConnection(db, {
    relation: "product-expense",
    source: { entityKind: "product", entityId: item.id },
    target: { entityKind: "expense", entityId: charge.id },
    label: "This Expense acquired this Product",
    evidence: {
      reasons: ["Synthetic itemized receipt names this exact variant"],
      contradictions: [],
      unknowns: [],
    },
  });
  const alias = uniqueName(testInfo, "Suggestions card");
  await createEntityFixture(page, "financialAccount", {
    name: alias,
    identity: { kind: "credit_card", issuer: null, network: "visa" },
    sourceAliases: [{ source: "monarch", alias, externalAccountId: null }],
  });
  const importId = await recordRows(page, alias)(alias, [
    {
      statementDate: "2026-05-11",
      providerAmount: -17.25,
      rawDescription: `${alias} CAFE`,
    },
  ]);
  await generateStatementSuggestions(db, importId);
  await drainDerivedRefreshFrontier(db);
  const seedCategoryAdvice = async () =>
    publishFieldAssessment(
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
  for (const family of [
    "Statements",
    "Connections and recommendations",
    "Fields",
  ])
    await expect(
      families.getByRole("button", { name: new RegExp(`^${family} [1-9]`) }),
    ).toBeVisible();

  // Both endpoints' Suggestions list under the record, in the All view.
  await gotoAuthenticatedPage(page, `/suggestions?record=product:${item.id}`);
  const rows = suggestionsTable(page).getByRole("row");
  const field = rows
    .filter({ hasText: "Field" })
    .filter({ hasText: "Category" });
  const connection = rows.filter({ hasText: "This Expense acquired" });
  await expect(field).toHaveCount(1);
  await expect(connection).toHaveCount(1);
  const recordLink = field.getByRole("link", { name: productName });
  await expect(recordLink).toBeVisible();
  await expect(recordLink.locator("svg, img").first()).toBeVisible();
  // The category is its full-path CategoryLabel pill, not a reference chip.
  await expect(
    field.locator(
      `a[href="/product-categories/${category.id}"] [data-slot="pill"]`,
    ),
  ).toContainText(categoryName);

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
  await expect(
    selected.getByRole("button", { name: /^Never suggest/ }),
  ).toBeDisabled();
  await page.getByRole("combobox", { name: "Sort", exact: true }).click();
  await page.getByRole("option", { name: "Most impact", exact: true }).click();
  await expect(selected).toHaveCount(0);
  await expect(
    field.getByRole("checkbox", { name: "Select row", exact: true }),
  ).not.toBeChecked();

  // Acquisition does not change the declared classification inputs, so the
  // existing category advice remains available after confirming the link.
  await connection
    .getByRole("button", { name: "Confirm", exact: true })
    .click();
  await expect
    .poll(() =>
      readEntityConnections(db, { entityKind: "product", entityId: item.id }),
    )
    .toEqual([]);
  await expect
    .poll(
      async () =>
        (
          await readExpense(
            page,
            charge.id,
            z.object({ productId: z.string().nullable() }),
          )
        ).productId,
    )
    .toBe(item.id);
  await expect(connection).toHaveCount(0);

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
  await ensureSystemUser(db);
  const alias = uniqueName(testInfo, "Statement card");
  const owner = await ensureMemberParty(page, alias);
  const category = await createEntityFixture(page, "spendingCategory", {
    name: `${alias} spending`,
  });
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
  const account = await createEntityFixture(page, "financialAccount", {
    name: alias,
    ledgerPartyId: owner.shortcode,
    provisional: false,
    identity: { kind: "credit_card", issuer: null, network: "visa" },
    sourceAliases: [{ source: "monarch", alias, externalAccountId: null }],
  });
  const recorded = await createEntityFixture(page, "financialTransaction", {
    accountId: account.id,
    amount: 61.07,
    merchant: `${alias} Hardware`,
    kind: "purchase",
    status: "pending",
    transactionDate: "2026-05-11",
  });
  const hardware = `${alias} HARDWARE 0441`;
  const hold = `${alias} HOLD`;
  const cafe = `${alias} CAFE`;
  const record = recordRows(page, alias);
  const importId = await record(alias, [
    {
      statementDate: "2026-05-12",
      providerAmount: -61.07,
      rawDescription: hardware,
      sourceCategory: "Shopping",
    },
    {
      // Uncategorized, so its create is never clean (with or without
      // decision labels): it is reviewed on its own.
      statementDate: "2026-05-04",
      providerAmount: -42.5,
      rawDescription: hold,
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
  await gotoAuthenticatedPage(page, view);
  const table = suggestionsTable(page);
  const rowFor = (text: string) =>
    table.getByRole("row").filter({ hasText: text });
  // The provider's category is named as its source's evidence, never "Category".
  await expect(
    table.getByRole("columnheader", { name: "Provider category" }),
  ).toBeVisible();
  // Without decision labels no create's kind is agreed, so nothing is clean.
  await expect(
    page.getByRole("button", { name: "Accept 0 clean" }),
  ).toBeDisabled();

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
  // A deferred pending candidate becomes bookable after applying status. Its
  // controls must retain focus across the next authoritative draft replan.
  await expect(
    page.getByText("Spending preview unavailable", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Updating spending preview…", { exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("checkbox", { name: "Apply status", exact: true })
    .check();
  // Preview the graph, including auto-created identity and no vendor account.
  const result = page.getByRole("region", {
    name: "Proposed result",
    exact: true,
  });
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
      "assessment.reviewBatch",
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

  // Publish manual review work without scheduling import-clean execution,
  // which would legitimately finish the same booking before the bulk click.
  const posted = await recordStatementRows(
    db,
    recordStatementRowsInput.parse({
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
  // Posting the hold books spending only after current category and identity advice.
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

  const accountId = await resolveOrThrow(db, "financialAccount", account.id);
  const spent = await getDb(db).execute<{ total: number }>(sql`
    SELECT coalesce(sum(e.cost),0)::float8 AS total FROM "Expense" e WHERE e."deletedAt" IS NULL
      AND e."purchaseId" IN (SELECT a."purchaseId" FROM "FinancialTransactionAllocation" a
        JOIN "FinancialTransaction" f ON f.id=a."transactionId" WHERE f."accountId"=${accountId} AND a."deletedAt" IS NULL)
  `);
  expect(spent.rows[0]?.total).toBe(103.57);

  await rowFor(cafe)
    .getByRole("button", { name: "Dismiss", exact: true })
    .click();
  await expect(rowFor(cafe)).toHaveCount(0);

  await gotoAuthenticatedPage(
    page,
    `/statement-rows?matchState=all&q=${encodeURIComponent(hardware)}`,
  );
  await expect(
    page
      .getByRole("table", { name: "Statement Rows Table" })
      .getByRole("row")
      .filter({ hasText: hardware }),
  ).toContainText("Matched");
});

// Shared infinite paging must cross the first page while totals still cover
// the full scope. Switching provider must replace both rows and amount.
test("Statement rows page observations with full totals and keep existing review links", async ({
  page,
}, testInfo) => {
  test.slow();
  const { db, actor } = await createEvidenceHarnessContext(page);
  const name = uniqueName(testInfo, "Paged observations");
  const account = await createEntityFixture(page, "financialAccount", {
    name,
    identity: { kind: "credit_card", issuer: null, network: "visa" },
  });
  const rows = Array.from({ length: 101 }, (_, index) => ({
    rowPosition: index + 1,
    accountDescriptor: name,
    statementDate: shiftPlainDate("2026-05-04", 100 - index),
    providerAmount: -1,
    merchant: name,
    rawDescription: `${name} ${String(index + 1).padStart(3, "0")}`,
  }));
  await recordStatementRows(
    db,
    recordStatementRowsInput.parse({
      import: {
        source: "monarch",
        fingerprint: `${name}-first`,
        label: "synthetic-pages.csv",
        dateKind: "posted",
        rowCountDeclared: rows.length,
      },
      rows,
    }),
    actor,
  );
  await recordStatementRows(
    db,
    recordStatementRowsInput.parse({
      import: {
        source: "mint",
        fingerprint: `${name}-other`,
        label: "synthetic-other.csv",
        dateKind: "posted",
        rowCountDeclared: 1,
      },
      rows: [
        {
          ...rows[0],
          rowPosition: 1,
          accountDescriptor: name,
          statementDate: "2026-05-04",
          providerAmount: -7,
          rawDescription: `${name} other`,
        },
      ],
    }),
    actor,
  );
  // Raw observations do not acquire a resolved account from an alias alone.
  await updateStatementRows(
    db,
    {
      selector: {
        filter: { source: "mint", importFingerprint: `${name}-other` },
      },
      data: { accountId: parseShortcodeFor("financialAccount", account.id) },
    },
    actor,
  );
  const pages: number[] = [];
  page.on("request", (request) => {
    for (const item of dispatchOperations(request)) {
      if (item.operation !== "statementRow.list") continue;
      const parsed = listStatementRowsInput.safeParse(item.input);
      if (parsed.success && parsed.data.filters?.source === "monarch")
        pages.push(parsed.data.pagination?.pageIndex ?? 0);
    }
  });
  await gotoAuthenticatedPage(
    page,
    `/statement-rows?source=monarch&matchState=unmatched&q=${encodeURIComponent(name)}`,
  );
  const table = page.getByRole("table", { name: "Statement Rows Table" });
  await expect(table.locator("tfoot")).toContainText("$101.00");
  const pane = page.getByRole("region", {
    name: "Statement Rows Table keyboard navigation",
    exact: true,
  });
  await pane.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect.poll(() => pages.includes(1)).toBe(true);
  await pane.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect(
    table.getByRole("row").filter({ hasText: `${name} 101` }),
  ).toBeVisible();
  await expect(table.locator("tfoot")).toContainText("$101.00");
  await page.getByRole("combobox", { name: "Source", exact: true }).click();
  await page.getByRole("option", { name: "mint", exact: true }).click();
  await expect(
    table.getByRole("row").filter({ hasText: `${name} other` }),
  ).toBeVisible();
  await expect(table.locator("tfoot")).toContainText("$7.00");
  await expect(
    table.getByRole("row").filter({ hasText: `${name} 101` }),
  ).toHaveCount(0);
  const review = table.getByRole("link", {
    name: "Review suggestions",
    exact: true,
  });
  await expect(review).toHaveAttribute(
    "href",
    new RegExp(
      `record=financialAccount%3A${account.id}|record=financialAccount:${account.id}`,
    ),
  );
  await review.click();
  await expect(page).toHaveURL(/\/suggestions\?/);
  await expect(page).toHaveURL(new RegExp(account.id));
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
  for (const family of ["Connections", "Fields"])
    await dialog.getByRole("checkbox", { name: family }).click();
  const estimate = dialog.getByRole("list", { name: "Sweep estimate" });
  await expect(estimate).toContainText("Statements");
  await expect(estimate).toContainText(/decision/);
  await dialog.getByRole("button", { name: "Start Sweep" }).click();
  const status = page.getByLabel("Sweep status");
  await expect(status).toBeVisible();
  await status.getByRole("link").first().click();
  await expect(page).toHaveURL(/\/runs\/RUN-/);
  await expect(
    page.getByRole("heading", { name: "Steps", exact: true }),
  ).toBeVisible();
});

// Failure modes: clean booking is hidden or cannot resume, and audit history
// becomes a second disconnected workspace. Field fill remains a fixed policy.
test("Suggestions contains automatic history and pausable statement spending", async ({
  page,
}) => {
  await gotoAuthenticatedPage(page, "/suggestions");
  await page.getByRole("tab", { name: "Automatic rules", exact: true }).click();
  await expect(page).toHaveURL(/status=rules/);
  const rules = page.getByRole("list", { name: "Automatic rules" });
  await expect(
    rules.getByRole("listitem", { name: "Field assignment" }),
  ).toHaveCount(0);
  const attach = rules.getByRole("listitem", { name: "Statement attach" });
  await expect(
    attach.getByRole("switch", { name: "Statement attach automatic rule" }),
  ).toBeEnabled();
  const spending = rules.getByRole("listitem", { name: "Statement spending" });
  const toggle = spending.getByRole("switch", {
    name: "Statement spending automatic rule",
  });
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await toggle.click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Turn off", exact: true })
    .click();
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await page
    .getByRole("tab", { name: "Automatic decisions", exact: true })
    .click();
  await expect(page).toHaveURL(/status=automatic/);
  await expect(
    page.getByRole("region", { name: "Automatic decisions", exact: true }),
  ).toBeVisible();
  await page.getByRole("tab", { name: "Pending", exact: true }).click();
  await expect(suggestionsTable(page)).toBeVisible();
  await gotoAuthenticatedPage(page, "/automatic-decisions");
  await expect(page).toHaveURL(/suggestions\?status=automatic/);
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
      publishFieldAssessment(
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
        "assessment.review",
        (item) =>
          assessmentReviewInput.safeParse(item.input).data?.intent === "apply",
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
  const product = await createEntityFixture(page, "product", {
    name,
    manufacturer: "Synthetic brand",
    tags: ["synthetic-brand", "collection:favorites", "mount"],
  });
  const id = await resolveOrThrow(db, "product", product.id);
  const runId = await ensureRun(db, actor, { purpose: "ai_suggest" });
  const removals = [
    {
      value: "synthetic-brand",
      probability: 0.99,
      reason: "Restates manufacturer",
    },
  ];
  const prediction = await publishAssessment(
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
      body: JSON.stringify(
        superjson.serialize({
          ok: true,
          data: fieldSuggestionsReply(route.request(), {
            suggestions: {
              tags: {
                assessmentId: prediction.id,
                value: "synthetic-brand",
                label: "Remove synthetic-brand",
                confidence: "high",
                probability: 0.99,
                detail: "Restates manufacturer",
                reasoning: "Synthetic retained pruning",
                alternatives: [],
                operation: "remove",
                removals,
              },
            },
          }),
        }),
      ),
    });
  });
  await gotoAuthenticatedPage(page, `/products?q=${encodeURIComponent(name)}`);
  await page.getByRole("button", { name: "Actions", exact: true }).click();
  await page.getByRole("menuitem", { name: "Columns…", exact: true }).click();
  await page.getByRole("button", { name: "Show Tags", exact: true }).click();
  await page.keyboard.press("Escape");
  const row = page
    .getByRole("table", { name: /Products table/i })
    .getByRole("row")
    .filter({ hasText: name });
  await row.getByRole("button", { name: /Remove synthetic-brand/ }).click();
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
    .toEqual(["collection:favorites", "mount"]);
  await expect
    .poll(
      async () =>
        (
          await getDb(db)
            .select()
            .from(feedback)
            .where(eq(feedback.assessmentId, prediction.id))
        ).filter((event) => event.operationId.startsWith("receipt:")).length,
    )
    .toBe(1);
  const events = await getDb(db)
    .select()
    .from(feedback)
    .where(eq(feedback.assessmentId, prediction.id));
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
