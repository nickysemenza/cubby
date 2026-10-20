import { financialBookingInput } from "@cubby/schemas/financial-booking";
import { financialSpendingAdvice } from "@cubby/schemas/financial-booking";
import { recordStatementRowsInput } from "@cubby/schemas/statement-row";
import { statementTransactionApplication } from "@cubby/schemas/statement-suggestion";
import { sql } from "drizzle-orm";
import { createEntity } from "tooling/factories/create";
import { createRepoEntity } from "tooling/factories/repo";
import { buildKernelContext } from "tooling/scenarios/context";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { getDb } from "~/server/db/helpers";
import { bookFinancialTransaction } from "~/server/domains/financial-transaction/repo/financial-booking";
import { kernelCtx } from "~/server/domains/run/service/suggestion-sweep.fixtures";
import { labelStatementSuggestions } from "~/server/domains/statement-import/service/statement-suggestion-labels";
import { executeEntity } from "~/server/entity-kernel";
import { entityCommandSchema } from "~/server/entity-kernel/contracts";
import { reviewAssessment } from "~/server/generic/assessment/repo/assessment-review";
import { listAutomaticDecisions } from "~/server/generic/assessment/repo/automatic-decisions";
import { listSuggestionPage } from "~/server/generic/assessment/repo/suggestion-list";
import { createSystemUserFixture } from "~/server/testing/repo.fixtures";

import { answering } from "./statement-decision-port.fixtures";
import { recordStatementRows, listStatementRows } from "./statement-row";
import { generateStatementSuggestionPage } from "./statement-suggestions";

// Failure modes: a clean accept writes only settlement evidence; a matched
// charge disappears before its spending is booked; unchanged re-import skips
// work; the automatic sample/optional switch withholds clean import spending.
describe("statement spending review and re-import", () => {
  const ctx = withTestDb();
  async function fixture() {
    await createSystemUserFixture(ctx.db);
    const owner = await createRepoEntity(ctx, "ledgerParty", {
      name: "Synthetic statement member",
      kind: "member",
    });
    const account = await createRepoEntity(ctx, "financialAccount", {
      name: "Synthetic statement card",
      identity: { kind: "credit_card", issuer: null, network: "visa" },
      ledgerPartyId: owner.output.id,
      provisional: false,
      sourceAliases: [
        {
          source: "monarch",
          alias: "Synthetic card 4242",
          externalAccountId: null,
        },
      ],
    });
    await createRepoEntity(ctx, "vendor", { name: "Synthetic Orchard" });
    const category = await createEntity(
      buildKernelContext(ctx.db, ctx.actor.userId),
      "spendingCategory",
      {
        name: "Synthetic grocery spend",
      },
    );
    const advice = financialSpendingAdvice.parse({
      spendingCategoryId: category.id,
      categoryConfidence: "high",
      vendorName: "Synthetic Orchard",
      vendorConfidence: "high",
      counterparty: "business",
    });
    const input = recordStatementRowsInput.parse({
      import: {
        source: "monarch",
        label: "synthetic-spending.csv",
        fingerprint: "synthetic-spending-import",
        dateKind: "posted",
        rowCountDeclared: null,
        notes: null,
      },
      rows: [
        {
          accountDescriptor: "Synthetic card 4242",
          statementDate: "2026-05-04",
          providerAmount: -42.5,
          merchant: "Synthetic Orchard",
          rawDescription: "SYNTHETIC ORCHARD",
          sourceCategory: "Groceries",
          providerStatus: "posted",
          providerNotes: null,
          rowPosition: 1,
        },
      ],
    });
    const recorded = await recordStatementRows(ctx.db, input, ctx.actor);
    return { input, recorded, account, advice };
  }
  const total = async () =>
    Number(
      (
        await getDb(ctx.db).execute<{ total: string }>(
          sql`SELECT coalesce(sum(cost),0)::text AS total FROM "Expense" WHERE "deletedAt" IS NULL`,
        )
      ).rows[0]!.total,
    );
  const label = async (
    advice: ReturnType<typeof financialSpendingAdvice.parse>,
    importId?: string,
  ) => {
    await generateStatementSuggestionPage(ctx.db, {
      after: null,
      runId: null,
      scope: { importId },
    });
    const result = await labelStatementSuggestions(ctx.db, {
      port: answering({ kind: "purchase", counterparty: "business" }),
      spendingAdvice: async () => advice,
      importId,
    });
    expect(result.failed).toEqual([]);
  };
  it("accepts a clean spending suggestion as a Purchase and categorized Expense", async () => {
    const { advice } = await fixture();
    await label(advice);
    const page = await listSuggestionPage(ctx.db, {
      family: "statement_transaction",
      limit: 20,
    });
    const suggestion = page.items.find(
      (row) => row.family === "statement_transaction",
    );
    expect(suggestion?.clean).toBe(true);
    await reviewAssessment(ctx.db, kernelCtx(ctx), {
      assessmentId: suggestion!.id,
      operationId: "synthetic-spending-accept",
      verdict: "correct",
      intent: "apply",
      application: {
        kind: "statement_transaction",
        action: "create",
        rejectedCandidateIds: [],
        fields: [],
      },
    });
    expect(await total()).toBe(42.5);
  });
  it("automatically books an unchanged matched-but-unbooked import once, retains its audit and skips later Expense edits", async () => {
    const { input, account, advice, recorded } = await fixture();
    const observed = (await listStatementRows(ctx.db, {})).data[0]!;
    await createRepoEntity(ctx, "financialTransaction", {
      accountId: account.output.id,
      kind: "purchase",
      status: "posted",
      amount: 42.5,
      postedDate: "2026-05-04",
      merchant: "Synthetic Orchard",
      rawDescription: "SYNTHETIC ORCHARD",
      sourceRefs: [{ source: "monarch", externalId: observed.externalId }],
    });
    const repeated = await recordStatementRows(ctx.db, input, ctx.actor);
    expect(repeated.inserted).toBe(0);
    await label(advice, recorded.batchId!);
    expect(await total()).toBe(42.5);
    await label(advice, recorded.batchId!);
    expect(await total()).toBe(42.5);
    const audit = await listAutomaticDecisions(ctx.db, {
      family: "statement_transaction",
      limit: 20,
    });
    expect(
      audit.items.some((row) =>
        row.automaticRule?.startsWith("statement_transaction.book_spending@"),
      ),
    ).toBe(true);
    const bookedExpense = await getDb(ctx.db).query.expense.findFirst();
    expect(bookedExpense).toBeDefined();
    const relatedAudit = await listAutomaticDecisions(ctx.db, {
      family: "statement_transaction",
      recordIds: [bookedExpense!.shortcode],
      limit: 20,
    });
    expect(
      relatedAudit.items.some((row) =>
        row.automaticRule?.startsWith("statement_transaction.book_spending@"),
      ),
    ).toBe(true);
    await executeEntity(
      kernelCtx(ctx),
      entityCommandSchema.parse({
        action: "update",
        entity: "expense",
        id: bookedExpense!.shortcode,
        data: { name: "Synthetic member-corrected expense title" },
      }),
    );
    await label(advice, recorded.batchId!);
    expect(
      (
        await listSuggestionPage(ctx.db, {
          family: "statement_transaction",
          limit: 20,
        })
      ).items,
    ).toEqual([]);
    expect(await total()).toBe(42.5);
  });
  it("retains published category advice when a non-web correction only chooses a Vendor", async () => {
    const { advice } = await fixture();
    await label(advice);
    const suggestion = (
      await listSuggestionPage(ctx.db, {
        family: "statement_transaction",
        limit: 20,
      })
    ).items[0]!;
    const vendor = await getDb(ctx.db).query.vendor.findFirst();
    const application = statementTransactionApplication.parse({
      kind: "statement_transaction",
      action: "create",
      booking: { vendorId: vendor!.shortcode },
    });
    await reviewAssessment(ctx.db, kernelCtx(ctx), {
      assessmentId: suggestion.id,
      operationId: "synthetic-vendor-only-review",
      verdict: "wrong",
      correction: { present: true, value: application },
      intent: "apply",
      application,
    });
    expect(await total()).toBe(42.5);
  });
  it("retires a pending matched booking when another shared finance path books it", async () => {
    const { advice, account } = await fixture();
    const row = (await listStatementRows(ctx.db, {})).data[0]!;
    const transaction = await createRepoEntity(ctx, "financialTransaction", {
      accountId: account.output.id,
      kind: "purchase",
      status: "posted",
      amount: 42.5,
      postedDate: "2026-05-04",
      merchant: "Synthetic Orchard",
      sourceRefs: [{ source: "monarch", externalId: row.externalId }],
    });
    await label(advice);
    expect(
      (
        await listSuggestionPage(ctx.db, {
          family: "statement_transaction",
          limit: 20,
        })
      ).items,
    ).toHaveLength(1);
    const vendor = await getDb(ctx.db).query.vendor.findFirst();
    await bookFinancialTransaction(
      ctx.db,
      financialBookingInput.parse({
        transactionId: transaction.output.id,
        vendorId: vendor!.shortcode,
        spendingCategoryId: advice.spendingCategoryId,
      }),
      ctx.actor,
    );
    await generateStatementSuggestionPage(ctx.db, { after: null, runId: null });
    expect(
      (
        await listSuggestionPage(ctx.db, {
          family: "statement_transaction",
          limit: 20,
        })
      ).items,
    ).toEqual([]);
    expect(await total()).toBe(42.5);
  });
  // Creating one Vendor must not invalidate the other independent clean
  // charges on the page or strand paid advice outside the label queue.
  it("books every independent new Vendor on an import page and reuses unchanged advice", async () => {
    const { input, advice } = await fixture();
    const names = [
      "Juniper Books",
      "Cobalt Cycles",
      "Amber Bakery",
      "Willow Hardware",
      "Lotus Cinema",
    ];
    const batch = recordStatementRowsInput.parse({
      ...input,
      import: { ...input.import, fingerprint: "synthetic-five-vendors" },
      rows: names.map((merchant, index) => ({
        ...input.rows[0],
        merchant,
        rawDescription: merchant.toUpperCase(),
        providerAmount: -(index + 1) * 11,
        rowPosition: index + 1,
      })),
    });
    const saved = await recordStatementRows(ctx.db, batch, ctx.actor);
    await generateStatementSuggestionPage(ctx.db, {
      after: null,
      runId: null,
      scope: { importId: saved.batchId! },
    });
    const labelled = await labelStatementSuggestions(ctx.db, {
      port: answering({ kind: "purchase", counterparty: "business" }),
      spendingAdvice: async ({ judgment }) => ({
        ...advice,
        vendorName: judgment.create!.merchant,
      }),
      importId: saved.batchId!,
    });
    expect(labelled.failed).toEqual([]);
    expect(await total()).toBe(165);
    const audit = await listAutomaticDecisions(ctx.db, {
      family: "statement_transaction",
      limit: 20,
    });
    expect(
      audit.items.filter((row) =>
        row.automaticRule?.startsWith("statement_transaction.book_spending@"),
      ).length,
    ).toBe(5);
    expect((await recordStatementRows(ctx.db, batch, ctx.actor)).inserted).toBe(
      0,
    );
    await generateStatementSuggestionPage(ctx.db, {
      after: null,
      runId: null,
      scope: { importId: saved.batchId! },
    });
    expect(await total()).toBe(165);
  });
});
