import { fieldInputFingerprint } from "~/server/generic/assessment/repo/field-input-fence";
import { drainDerivedRefreshFrontier } from "~/server/testing/background-queue";
import type { Page } from "@playwright/test";
import superjson from "superjson";
import { fieldSuggestionsOut } from "@cubby/schemas/ai";
import { assessmentReviewInput } from "@cubby/schemas/assessment";
import type { StatementRowInput } from "@cubby/schemas/statement-row";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { BROWSER_OPERATION_PATH } from "~/lib/browser-operation-path";
import { user } from "~/server/db/auth.schema";
import {
  product as productTable,
  assessmentState as suggestionTable,
  feedback,
} from "~/server/db/schema";
import {
  publishEntityConnection,
  readEntityConnections,
} from "~/server/domains/connection/repo/entity-connections";
import { ensureRun } from "~/server/domains/run/repo/ensure-run";
import { generateStatementSuggestionPage } from "~/server/domains/statement-import/repo/statement-suggestions";
import { publishAssessment } from "~/server/generic/assessment/repo/assessment";
import { getDb } from "~/server/db/helpers";
import { resolveOrThrow } from "~/server/generic/shortcode/repo/shortcode-resolver";

import { dispatchesOperation, unbatchFor } from "./support/dispatch-wire";
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

/** Publishes statement Suggestions for every unmatched charge, as a statement Sweep step does. */
async function generateStatementSuggestions(db: Db) {
  let after: Parameters<typeof generateStatementSuggestionPage>[1]["after"] =
    null;
  for (;;) {
    const page = await generateStatementSuggestionPage(db, {
      after,
      runId: null,
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
  };

const suggestionsTable = (page: Page) =>
  page.getByRole("table", { name: "Suggestions" });

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
  await recordRows(page, alias)(alias, [
    {
      statementDate: "2026-05-11",
      providerAmount: -17.25,
      rawDescription: `${alias} CAFE`,
    },
  ]);
  await generateStatementSuggestions(db);
  await drainDerivedRefreshFrontier(db);
  await getDb(db)
    .insert(suggestionTable)
    .values({
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
    });

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

  // Confirm first: the field write changes the Product, which retires its
  // pending connection evidence.
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
  const { db } = await createEvidenceHarnessContext(page);
  await ensureSystemUser(db);
  const alias = uniqueName(testInfo, "Statement card");
  const account = await createEntityFixture(page, "financialAccount", {
    name: alias,
    identity: { kind: "credit_card", issuer: null, network: "visa" },
    sourceAliases: [{ source: "monarch", alias, externalAccountId: null }],
  });
  const recorded = await createEntityFixture(page, "financialTransaction", {
    accountId: account.id,
    amount: 61.07,
    merchant: `${alias} Hardware`,
    kind: "purchase",
    status: "posted",
    postedDate: "2026-05-11",
  });
  const hardware = `${alias} HARDWARE 0441`;
  const hold = `${alias} HOLD`;
  const cafe = `${alias} CAFE`;
  const record = recordRows(page, alias);
  await record(alias, [
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
  await generateStatementSuggestions(db);

  const view = `/suggestions?family=statement_transaction&record=financialAccount:${account.id}&group=account_month`;
  await gotoAuthenticatedPage(page, view);
  const table = suggestionsTable(page);
  const rowFor = (text: string) =>
    table.getByRole("row").filter({ hasText: text });
  // The provider's category is named as its source's evidence, never "Category".
  await expect(
    table.getByRole("columnheader", { name: "Monarch category" }),
  ).toBeVisible();
  // Without decision labels no create's kind is agreed, so nothing is clean.
  await expect(
    page.getByRole("button", { name: "Accept 0 clean" }),
  ).toBeDisabled();

  // The attach names its candidate in the review it sends.
  await rowFor(hardware).getByRole("button", { name: "Show evidence" }).click();
  await expect(
    page.getByRole("list", { name: "Candidate transactions" }),
  ).toContainText("61.07");
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

  await record(`${alias}-posted`, [
    {
      statementDate: "2026-05-06",
      providerAmount: -42.5,
      rawDescription: `${alias} GROCER`,
      sourceCategory: "Groceries",
    },
  ]);
  // Settling the recorded hold at its exact amount is clean without labels.
  await generateStatementSuggestions(db);
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

// The migration-seeded rules read through `suggestions.rules`: Field Addition
// carried forward On, Statement attach Off until reviews make it eligible.
test("Automatic rules lists each seeded rule with its state and switch", async ({
  page,
}) => {
  await gotoAuthenticatedPage(page, "/suggestions");
  await page.getByRole("tab", { name: /^Automatic rules/ }).click();
  await expect(page).toHaveURL(/status=rules/);
  const rules = page.getByRole("list", { name: "Automatic rules" });
  const field = rules.getByRole("listitem", { name: "Field Addition" });
  await expect(field.getByText("On", { exact: true })).toBeVisible();
  await expect(
    field.getByRole("switch", { name: "Field Addition automatic rule" }),
  ).toHaveAttribute("aria-checked", "true");
  const attach = rules.getByRole("listitem", { name: "Statement attach" });
  await expect(attach.getByText("Off", { exact: true })).toBeVisible();
  await expect(attach.getByText("Not yet eligible")).toBeVisible();
  await expect(
    attach.getByRole("switch", { name: "Statement attach automatic rule" }),
  ).toHaveAttribute("aria-disabled", "true");
  await page
    .getByRole("button", { name: "Review automatic decisions" })
    .click();
  await expect(page).toHaveURL(/\/automatic-decisions/);
  await expect(
    page.getByRole("region", { name: "Automatic decisions", exact: true }),
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
  await getDb(db)
    .insert(suggestionTable)
    .values(
      await Promise.all(
        recordIds.map(async (recordId) => ({
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
        })),
      ),
    );
  const acceptance = Promise.withResolvers<void>();
  await page.route(`**${BROWSER_OPERATION_PATH}`, async (route) => {
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
  await page.route(`**${BROWSER_OPERATION_PATH}`, async (route) => {
    if (await unbatchFor(route, ["ai.suggestFields"])) return;
    if (!dispatchesOperation(route.request(), "ai.suggestFields"))
      return route.continue();
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(
        superjson.serialize({
          ok: true,
          data: fieldSuggestionsOut.parse({
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
