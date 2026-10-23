import { financialBookingInput } from "@cubby/schemas/financial-booking";
import { financialSpendingAdvice } from "@cubby/schemas/financial-booking";
import { recordSourceTransactionRecordsInput } from "@cubby/schemas/source-transaction-record";
import { statementTransactionApplication } from "@cubby/schemas/statement-suggestion";
import { isNull, sql } from "drizzle-orm";
import { createEntity } from "tooling/factories/create";
import { createRepoEntity } from "tooling/factories/repo";
import { buildKernelContext } from "tooling/scenarios/context";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { getDb } from "~/server/db/helpers";
import { vendor as vendorTable } from "~/server/db/schema";
import { bookFinancialTransaction } from "~/server/domains/financial-transaction/repo/financial-booking";
import { kernelCtx } from "~/server/domains/run/service/suggestion-sweep.fixtures";
import { labelStatementSuggestions } from "~/server/domains/transaction-import/service/statement-suggestion-labels";
import { executeEntity } from "~/server/entity-kernel";
import { entityCommandSchema } from "~/server/entity-kernel/contracts";
import { reviewAssessment } from "~/server/generic/assessment/repo/assessment-review";
import { listAutomaticDecisions } from "~/server/generic/assessment/repo/automatic-decisions";
import { listSuggestionPage } from "~/server/generic/assessment/repo/suggestion-list";

import { recordSourceTransactionRecords } from "./source-transaction-record";
import { listSourceTransactionRecords } from "./source-transaction-record.fixtures";
import { answering } from "./statement-decision-port.fixtures";
import { previewStatementSuggestion } from "./statement-suggestion-preview";
import { readStatementSuggestions } from "./statement-suggestion-read";
import { generateStatementSuggestionPage } from "./statement-suggestions";

// Failure modes: a clean accept writes only settlement evidence; a matched
// charge disappears before its spending is booked; unchanged re-import skips
// work; the automatic sample/optional switch withholds clean import spending.
describe("statement spending review and re-import", () => {
  const ctx = withTestDb();
  async function fixture(providerTransactionId: string | null = null) {
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
    const input = recordSourceTransactionRecordsInput.parse({
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
          providerTransactionId,
          providerStatus: "posted",
          providerNotes: null,
          rowPosition: 1,
        },
      ],
    });
    const recorded = await recordSourceTransactionRecords(
      ctx.db,
      input,
      ctx.actor,
    );
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
  const pendingPreview = async () => {
    await generateStatementSuggestionPage(ctx.db, { after: null, runId: null });
    const states = await getDb(ctx.db).query.assessmentState.findMany();
    const [suggestion] = await readStatementSuggestions(
      ctx.db,
      states.map((state) => state.id),
    );
    return suggestion!;
  };
  // Preview must fence missing/stale assessments and invalid drafts before
  // planning, replan the selected draft, and never publish or mutate evidence.
  it("fences missing fingerprints, replaced assessments, and changed statement evidence in preview", async () => {
    await fixture();
    const suggestion = await pendingPreview();
    const input = {
      assessmentId: suggestion.assessmentId,
      expectedFingerprint: suggestion.fingerprint,
      application: { kind: "statement_transaction", action: "create" },
    };
    await expect(
      previewStatementSuggestion(ctx.db, {
        ...input,
        expectedFingerprint: undefined,
      }),
    ).rejects.toThrow(/expectedFingerprint/i);
    await expect(
      previewStatementSuggestion(ctx.db, {
        ...input,
        assessmentId: crypto.randomUUID(),
      }),
    ).rejects.toThrow(/no longer available/i);
    await expect(
      previewStatementSuggestion(ctx.db, {
        ...input,
        expectedFingerprint: "synthetic-stale",
      }),
    ).rejects.toThrow(/fingerprint changed/i);
    await getDb(ctx.db).execute(
      sql`UPDATE "SourceTransactionRecord" SET "rawDescription" = 'SYNTHETIC CHANGED EVIDENCE'`,
    );
    await expect(previewStatementSuggestion(ctx.db, input)).rejects.toThrow(
      /evidence changed/i,
    );
  });
  it("replans draft kind and booking without writing transactions, vendors, aliases, or assessment state", async () => {
    const { advice } = await fixture();
    const suggestion = await pendingPreview();
    const snapshot = async () =>
      (
        await getDb(ctx.db).execute<{ state: unknown }>(sql`
      SELECT jsonb_build_object(
        'vendors', (SELECT jsonb_agg(to_jsonb(v)) FROM "Vendor" v),
        'accounts', (SELECT jsonb_agg(to_jsonb(v)) FROM "VendorAccount" v),
        'transactions', (SELECT jsonb_agg(to_jsonb(v)) FROM "FinancialTransaction" v),
        'purchases', (SELECT jsonb_agg(to_jsonb(v)) FROM "Purchase" v),
        'expenses', (SELECT jsonb_agg(to_jsonb(v)) FROM "Expense" v),
        'refs', (SELECT jsonb_agg(to_jsonb(v)) FROM "EntityExternalId" v),
        'rows', (SELECT jsonb_agg(to_jsonb(v)) FROM "SourceTransactionRecord" v),
        'assessments', (SELECT jsonb_agg(to_jsonb(v)) FROM "AssessmentState" v)
      ) AS state
    `)
      ).rows[0]!.state;
    const before = await snapshot();
    const input = {
      assessmentId: suggestion.assessmentId,
      expectedFingerprint: suggestion.fingerprint,
      application: {
        kind: "statement_transaction",
        action: "create",
        booking: {
          spendingCategoryId: advice.spendingCategoryId,
          reviewedVendorName: "Synthetic Orchard",
        },
      },
    };
    const result = await previewStatementSuggestion(ctx.db, input);
    expect(result).toMatchObject({
      action: "create",
      kind: "purchase",
      spending: { status: "ready", effect: "create_aggregate" },
    });
    const transfer = await previewStatementSuggestion(ctx.db, {
      ...input,
      application: { ...input.application, kindOverride: "account_transfer" },
    });
    expect(transfer).toMatchObject({
      kind: "account_transfer",
      spending: { status: "deferred" },
    });
    expect(await snapshot()).toEqual(before);
  });
  it("refuses ambiguous attach drafts and preserves selected identity, allocations and projected fields", async () => {
    const { account, advice } = await fixture();
    const makeTransaction = () =>
      createRepoEntity(ctx, "financialTransaction", {
        accountId: account.output.id,
        kind: "purchase",
        status: "pending",
        amount: 42.5,
        transactionDate: "2026-05-04",
        merchant: "Synthetic Orchard",
        sourceRefs: [],
      });
    const first = await makeTransaction();
    const second = await makeTransaction();
    const vendor = await getDb(ctx.db).query.vendor.findFirst({
      where: isNull(vendorTable.systemKey),
    });
    const purchase = await createRepoEntity(ctx, "purchase", {
      vendorId: vendor!.shortcode,
      date: "2026-05-04",
      statedTotal: 42.5,
    });
    const suggestion = await pendingPreview();
    const input = {
      assessmentId: suggestion.assessmentId,
      expectedFingerprint: suggestion.fingerprint,
      application: { kind: "statement_transaction", action: "attach" },
    };
    await expect(previewStatementSuggestion(ctx.db, input)).rejects.toThrow(
      /Name the transaction/i,
    );
    await expect(
      previewStatementSuggestion(ctx.db, {
        ...input,
        application: { ...input.application, transactionId: "FT4K7M" },
      }),
    ).rejects.toThrow(/Invalid|Expected|shortcode/i);
    await expect(
      previewStatementSuggestion(ctx.db, {
        ...input,
        application: {
          ...input.application,
          transactionId: first.output.id,
          fields: ["amount"],
        },
      }),
    ).rejects.toThrow(/already matches/i);
    const application = {
      ...input.application,
      transactionId: second.output.id,
      fields: ["status"],
      booking: {
        purchaseId: purchase.output.id,
        spendingCategoryId: advice.spendingCategoryId,
        reviewedVendorName: "Synthetic Orchard",
      },
    };
    const result = await previewStatementSuggestion(ctx.db, {
      ...input,
      application,
    });
    expect(result.spending).toMatchObject({
      status: "ready",
      request: { transactionId: second.output.id },
    });
    expect(
      (await getDb(ctx.db).query.financialTransaction.findMany()).every(
        (row) => row.status === "pending",
      ),
    ).toBe(true);
    await reviewAssessment(ctx.db, kernelCtx(ctx), {
      assessmentId: suggestion.assessmentId,
      operationId: "synthetic-preview-attach",
      verdict: "wrong",
      correction: {
        present: true,
        value: statementTransactionApplication.parse(application),
      },
      expectedFingerprint: suggestion.fingerprint,
      intent: "apply",
      application: statementTransactionApplication.parse(application),
    });
    expect(await total()).toBe(42.5);
  });
  it("retains existing allocations when previewing attachment to an already booked transaction", async () => {
    const { account, advice } = await fixture();
    const transaction = await createRepoEntity(ctx, "financialTransaction", {
      accountId: account.output.id,
      kind: "purchase",
      status: "posted",
      amount: 42.5,
      postedDate: "2026-05-04",
      merchant: "Synthetic Orchard",
      sourceRefs: [
        { source: "synthetic-bank", externalId: "synthetic-already-booked" },
      ],
    });
    const vendor = await getDb(ctx.db).query.vendor.findFirst({
      where: isNull(vendorTable.systemKey),
    });
    await bookFinancialTransaction(
      ctx.db,
      financialBookingInput.parse({
        transactionId: transaction.output.id,
        vendorId: vendor!.shortcode,
        spendingCategoryId: advice.spendingCategoryId,
      }),
      ctx.actor,
    );
    const suggestion = await pendingPreview();
    const result = await previewStatementSuggestion(ctx.db, {
      assessmentId: suggestion.assessmentId,
      expectedFingerprint: suggestion.fingerprint,
      application: {
        kind: "statement_transaction",
        action: "attach",
        transactionId: transaction.output.id,
      },
    });
    expect(result.spending).toMatchObject({
      status: "already_booked",
      request: { transactionId: transaction.output.id },
    });
    expect(await total()).toBe(42.5);
  });
  // Categories are provider observations, never a fuzzy same-merchant join.
  it("retains conflicting category observations and scopes source evidence to charge membership", async () => {
    const { input, account } = await fixture("synthetic-category-charge");
    await recordSourceTransactionRecords(
      ctx.db,
      recordSourceTransactionRecordsInput.parse({
        ...input,
        import: { ...input.import, fingerprint: "synthetic-category-reexport" },
        rows: [{ ...input.rows[0], sourceCategory: "Food and drink" }],
      }),
      ctx.actor,
    );
    await recordSourceTransactionRecords(
      ctx.db,
      recordSourceTransactionRecordsInput.parse({
        ...input,
        import: { ...input.import, fingerprint: "synthetic-other-charge" },
        rows: [
          {
            ...input.rows[0],
            statementDate: "2026-05-05",
            providerTransactionId: "synthetic-unrelated-charge",
            sourceCategory: "Unrelated category",
          },
        ],
      }),
      ctx.actor,
    );
    await generateStatementSuggestionPage(ctx.db, { after: null, runId: null });
    const states = await getDb(ctx.db).query.assessmentState.findMany();
    const suggestions = await readStatementSuggestions(
      ctx.db,
      states.map((state) => state.id),
    );
    const suggestion = suggestions.find(
      (item) => item.statementDate === "2026-05-04",
    )!;
    expect(suggestion.sourceCategories).toEqual([
      { source: "monarch", sourceCategory: "Food and drink" },
      { source: "monarch", sourceCategory: "Groceries" },
    ]);
    await recordSourceTransactionRecords(
      ctx.db,
      recordSourceTransactionRecordsInput.parse({
        ...input,
        import: {
          ...input.import,
          source: "copilot",
          fingerprint: "synthetic-second-provider",
        },
        rows: [{ ...input.rows[0], sourceCategory: "Dining" }],
      }),
      ctx.actor,
    );
    const observations = (await listSourceTransactionRecords(ctx.db, {})).data;
    const primary = observations.find(
      (row) => row.source === "monarch" && row.statementDate === "2026-05-04",
    )!;
    const secondProvider = observations.find(
      (row) => row.source === "copilot",
    )!;
    expect(
      (await readStatementSuggestions(ctx.db, [suggestion.assessmentId]))[0]!
        .sourceCategories,
    ).toEqual([
      { source: "monarch", sourceCategory: "Food and drink" },
      { source: "monarch", sourceCategory: "Groceries" },
    ]);
    const transaction = await createRepoEntity(ctx, "financialTransaction", {
      accountId: account.output.id,
      kind: "purchase",
      status: "posted",
      amount: 42.5,
      postedDate: "2026-05-04",
      merchant: "Synthetic Orchard",
      sourceRefs: [primary, secondProvider].map((row) => ({
        source: row.source,
        externalId: row.externalId,
      })),
    });

    expect(
      await readStatementSuggestions(ctx.db, [suggestion.assessmentId]),
    ).toEqual([]);
    // Shared settlement refs establish cross-provider membership; the stale
    // create suggestion is replaced by pending booking work for that charge.
    await generateStatementSuggestionPage(ctx.db, { after: null, runId: null });
    const refreshedStates = await getDb(
      ctx.db,
    ).query.assessmentState.findMany();
    const refreshed = await readStatementSuggestions(
      ctx.db,
      refreshedStates.map((state) => state.id),
    );
    const booking = refreshed.find(
      (item) =>
        item.source === "monarch" && item.statementDate === "2026-05-04",
    );
    expect(booking).toMatchObject({
      recommended: "book",
      matchedTransactionId: transaction.output.id,
      sourceCategories: [
        { source: "copilot", sourceCategory: "Dining" },
        { source: "monarch", sourceCategory: "Food and drink" },
        { source: "monarch", sourceCategory: "Groceries" },
      ],
    });
  });
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
    const observed = (await listSourceTransactionRecords(ctx.db, {})).data[0]!;
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
    const repeated = await recordSourceTransactionRecords(
      ctx.db,
      input,
      ctx.actor,
    );
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
    const vendor = await getDb(ctx.db).query.vendor.findFirst({
      where: isNull(vendorTable.systemKey),
    });
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
    const row = (await listSourceTransactionRecords(ctx.db, {})).data[0]!;
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
    const vendor = await getDb(ctx.db).query.vendor.findFirst({
      where: isNull(vendorTable.systemKey),
    });
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
    const batch = recordSourceTransactionRecordsInput.parse({
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
    const saved = await recordSourceTransactionRecords(
      ctx.db,
      batch,
      ctx.actor,
    );
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
    expect(
      (await recordSourceTransactionRecords(ctx.db, batch, ctx.actor)).inserted,
    ).toBe(0);
    await generateStatementSuggestionPage(ctx.db, {
      after: null,
      runId: null,
      scope: { importId: saved.batchId! },
    });
    expect(await total()).toBe(165);
  });
});
