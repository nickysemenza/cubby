import { suggestionStatus } from "@cubby/schemas/ai";
import { financialBookingInput } from "@cubby/schemas/financial-booking";
import { financialSpendingAdvice } from "@cubby/schemas/financial-booking";
import { recordSourceTransactionRecordsInput } from "@cubby/schemas/source-transaction-record";
import { statementTransactionApplication } from "@cubby/schemas/statement-suggestion";
import { eq, isNull, sql } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import { createEntity } from "tooling/factories/create";
import { createRepoEntity } from "tooling/factories/repo";
import { buildKernelContext } from "tooling/scenarios/context";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it, vi } from "vitest";

import { getDb, runAfterCommit } from "~/server/db/helpers";
import { relationalSql } from "~/server/db/helpers/relational-sql";
import {
  suggestionTable,
  sourceTransactionRecord,
  sourceOccurrence,
  vendor as vendorTable,
} from "~/server/db/schema";
import { updateFinancialAccount } from "~/server/domains/financial-account/repo/financial-account";
import { bookFinancialTransaction } from "~/server/domains/financial-transaction/repo/financial-booking";
import { kernelCtx } from "~/server/domains/run/service/suggestion-sweep.fixtures";
import { labelStatementSuggestions } from "~/server/domains/transaction-import/service/statement-suggestion-labels";
import { executeEntity } from "~/server/entity-kernel";
import { entityCommandSchema } from "~/server/entity-kernel/contracts";
import { isSerializationFailure } from "~/server/errors/db-errors";
import * as changes from "~/server/generic/changes/repo/change";
import {
  lockJobs,
  replaceJobGeneration,
} from "~/server/generic/jobs/jobs.fixtures";
import { enqueueJob } from "~/server/generic/jobs/repo/producer";
import { listAutomaticDecisions } from "~/server/generic/suggestions/repo/automatic-decisions";
import { reviewSuggestion } from "~/server/generic/suggestions/repo/review";
import { listSuggestionPage } from "~/server/generic/suggestions/repo/suggestion-list";
import { buildCrudServices } from "~/server/http/request-context";
import { drainStoredDerived } from "~/server/testing/background-queue";

import {
  sourceObservationColumns,
  sourceObservationFrom,
} from "./source-observation-state";
import { updateSourceTransactionRecords } from "./source-transaction-record";
import { recordSourceTransactionRecords } from "./source-transaction-record";
import { listSourceTransactionRecords } from "./source-transaction-record.fixtures";
import { answering } from "./statement-decision-port.fixtures";
import * as statementApplication from "./statement-suggestion-application";
import { previewStatementSuggestion } from "./statement-suggestion-preview";
import { readStatementSuggestions } from "./statement-suggestion-read";
import { generateStatementSuggestionPage } from "./statement-suggestions";

// Failure modes: a clean accept writes only settlement evidence; a matched
// charge disappears before its spending is booked; unchanged re-import skips
// work; the automatic sample/optional switch withholds clean import spending.
describe("statement spending review and re-import", () => {
  const ctx = withTestDb();
  async function fixture(
    providerTransactionId: string | null = null,
    ownerKind: "member" | "household" = "member",
  ) {
    const owner = await createRepoEntity(ctx, "ledgerParty", {
      name: "Synthetic statement member",
      kind: ownerKind,
    });
    const account = await createRepoEntity(ctx, "financialAccount", {
      name: "Synthetic statement card",
      identity: { kind: "credit_card", network: "visa" },
      ledgerPartyId: owner.output.id,

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
          ...(providerTransactionId
            ? {
                providerAccountId: "synthetic-statement-account",
                providerData: {
                  id: providerTransactionId,
                  account_id: "synthetic-statement-account",
                },
              }
            : {}),
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
  const labelAndRefreshReads = async (
    advice: ReturnType<typeof financialSpendingAdvice.parse>,
    importId?: string,
  ) => {
    await generateStatementSuggestionPage(ctx.db, {
      servicesFor: buildCrudServices,
      after: null,
      runId: null,
      scope: { importId },
    });
    const result = await labelStatementSuggestions(ctx.db, {
      port: answering({ kind: "purchase", counterparty: "business" }),
      spendingAdvice: async () => advice,
      scope: { importId },
    });
    expect(result.failed).toEqual([]);
    await drainStoredDerived(ctx.db);
  };
  const pendingPreview = async () => {
    await generateStatementSuggestionPage(ctx.db, {
      servicesFor: buildCrudServices,
      after: null,
      runId: null,
    });
    const states = await getDb(ctx.db).query.suggestionTable.findMany();
    const [suggestion] = await readStatementSuggestions(
      ctx.db,
      states.map((state) => state.id),
    );
    return suggestion!;
  };
  it.each(["once", "exhausted", "stale", "committed"] as const)(
    "preserves shared-card application and replay after %s contention",
    async (mode) => {
      const { advice, account } = await fixture(null, "household");
      await labelAndRefreshReads(advice);
      const page = await listSuggestionPage(ctx.db, {
        family: "statement_transaction",
        limit: 20,
      });
      const suggestion = page.items[0]!;
      const command = {
        suggestionId: suggestion.id,
        operationId: "synthetic-shared-card-contention",
        verdict: "correct" as const,
        correction: { present: false as const },
        intent: "apply" as const,
        expectedFingerprint: suggestion.fingerprint!,
        application: statementTransactionApplication.parse({
          kind: "statement_transaction",
          action: "create",
        }),
      };
      await expect(
        previewStatementSuggestion(ctx.db, {
          suggestionId: command.suggestionId,
          expectedFingerprint: command.expectedFingerprint,
          application: command.application,
        }),
      ).resolves.toMatchObject({
        spending: { status: "ready", purchaserId: null },
      });
      const read = async () =>
        (
          await getDb(ctx.db).execute<{
            transactions: number;
            allocations: number;
            purchases: number;
            expenses: number;
            feedback: number;
            totalFeedback: number;
          }>(sql`SELECT
      (SELECT count(*)::int FROM "FinancialTransaction") AS transactions,
      (SELECT count(*)::int FROM "FinancialTransactionAllocation") AS allocations,
      (SELECT count(*)::int FROM "Purchase") AS purchases,
      (SELECT count(*)::int FROM "Expense") AS expenses,
      (SELECT count(*)::int FROM "Suggestion" s CROSS JOIN LATERAL jsonb_array_elements(s.decisions) decision WHERE s.id = ${suggestion.id}::uuid) AS "totalFeedback",
      (SELECT count(*)::int FROM "Suggestion" s CROSS JOIN LATERAL jsonb_array_elements(s.decisions) decision WHERE s.id = ${suggestion.id}::uuid AND decision->>'operationId' IN (${command.operationId}, ${`command-application:${command.operationId}`})) AS feedback`)
        ).rows[0]!;
      const before = await read();
      await enqueueJob(ctx.db, {
        key: "synthetic:statement-contention",
        kind: "synthetic.contention",
        input: {},
      });
      const invalidate = changes.recordChange;
      let calls = 0;
      let external = false;
      const current = statementApplication.currentStatementApplication;
      let builds = 0;
      const rebuilding = vi
        .spyOn(statementApplication, "currentStatementApplication")
        .mockImplementation(async (...args) => {
          builds++;
          const proposal = await current(...args);
          if (mode === "stale" && builds === 1) {
            external = true;
            try {
              await updateFinancialAccount(
                ctx.db,
                account.output.id,
                { ledgerPartyId: null },
                ctx.actor,
              );
            } finally {
              external = false;
            }
          }
          return proposal;
        });
      const racing = vi
        .spyOn(changes, "recordChange")
        .mockImplementation(async (db, changeEvent) => {
          if (
            changeEvent.kind === "source" &&
            changeEvent.categories.includes("financialTransaction") &&
            changeEvent.categories.includes("expense") &&
            !external
          ) {
            calls++;
            if (mode === "exhausted" || (mode !== "committed" && calls === 1)) {
              // A synthetic stale-row fence keeps real PostgreSQL retry and
              // money/receipt rollback coverage without a mutable capture counter.
              await replaceJobGeneration(ctx.db, {
                key: "synthetic:statement-contention",
              });
              await lockJobs(db, { key: "synthetic:statement-contention" });
            }
            if (mode === "committed" && calls === 1) {
              await runAfterCommit(db, async () => {
                throw new Error("Synthetic post-commit failure", {
                  cause: { code: "40001" },
                });
              });
            }
          }
          return invalidate(db, changeEvent);
        });
      try {
        const scenarios = {
          once: async () => {
            const result = await reviewSuggestion(
              ctx.db,
              kernelCtx(ctx),
              command,
            );
            expect(calls).toBe(2);
            expect(builds).toBe(2);
            return result;
          },
          exhausted: async () => {
            await expect(
              reviewSuggestion(ctx.db, kernelCtx(ctx), command),
            ).rejects.toSatisfy(isSerializationFailure);
            expect(calls).toBe(3);
            expect(builds).toBe(3);
            // A refused application records no review.
            expect(await read()).toEqual(before);
            expect(
              await getDb(ctx.db).query.suggestionTable.findFirst({
                where: {
                  RAW: (table: PgTable) =>
                    relationalSql(table, eq(suggestionTable.id, suggestion.id)),
                },
              }),
            ).toMatchObject({ active: true, status: "pending" });
            racing.mockRestore();
            return reviewSuggestion(ctx.db, kernelCtx(ctx), command);
          },
          stale: async () => {
            await expect(
              reviewSuggestion(ctx.db, kernelCtx(ctx), command),
            ).rejects.toThrow(/changed since review: spending\./i);
            expect(builds).toBe(2);
            // A refused application records no review.
            expect(await read()).toEqual(before);
            expect(
              await getDb(ctx.db).query.suggestionTable.findFirst({
                where: {
                  RAW: (table: PgTable) =>
                    relationalSql(table, eq(suggestionTable.id, suggestion.id)),
                },
              }),
            ).toMatchObject({ active: true, status: "pending" });
            return;
          },
          committed: async () => {
            await expect(
              reviewSuggestion(ctx.db, kernelCtx(ctx), command),
            ).rejects.toThrow(
              /Transaction committed, but an after-commit effect failed/,
            );
            expect(calls).toBe(1);
            expect(builds).toBe(1);
            racing.mockRestore();
            const result = await reviewSuggestion(
              ctx.db,
              kernelCtx(ctx),
              command,
            );
            expect(builds).toBe(1);
            return result;
          },
        };
        const result = await scenarios[mode]();
        if (!result) return;
        expect(result).toMatchObject({ applied: true });
        expect(await read()).toEqual({
          transactions: before.transactions + 1,
          allocations: before.allocations + 1,
          purchases: before.purchases + 1,
          expenses: before.expenses + 1,
          feedback: before.feedback + 2,
          totalFeedback: before.totalFeedback + 2,
        });
        expect(
          await getDb(ctx.db).query.suggestionTable.findFirst({
            where: {
              RAW: (table: PgTable) =>
                relationalSql(table, eq(suggestionTable.id, suggestion.id)),
            },
          }),
        ).toMatchObject({ status: "applied" });
        const stored = await read();
        expect(await reviewSuggestion(ctx.db, kernelCtx(ctx), command)).toEqual(
          result,
        );
        expect(await read()).toEqual(stored);
      } finally {
        racing.mockRestore();
        rebuilding.mockRestore();
      }
    },
  );
  it("replays the exact committed booking receipt before a later occurrence hold", async () => {
    const { advice } = await fixture();
    await labelAndRefreshReads(advice);
    const [suggestion] = await readStatementSuggestions(
      ctx.db,
      (await getDb(ctx.db).query.suggestionTable.findMany()).map(
        (state) => state.id,
      ),
    );
    if (!suggestion) throw new Error("Synthetic source proposal missing");
    const application = statementTransactionApplication.parse({
      kind: "statement_transaction",
      action: "create",
      booking: { costType: "services" },
    });
    const command = {
      suggestionId: suggestion.suggestionId,
      expectedFingerprint: suggestion.fingerprint ?? suggestion.suggestionId,
      operationId: "synthetic-source-replay",
      verdict: "wrong" as const,
      correction: { present: true as const, value: application },
      intent: "apply" as const,
      application,
    };
    const receipt = await reviewSuggestion(ctx.db, kernelCtx(ctx), command);
    await getDb(ctx.db)
      .update(sourceOccurrence)
      .set({ reviewState: "identity_conflict" });
    expect(await reviewSuggestion(ctx.db, kernelCtx(ctx), command)).toEqual(
      receipt,
    );
    expect(await total()).toBe(42.5);
    expect(await getDb(ctx.db).query.expense.findMany()).toMatchObject([
      { costType: "services", cost: 42.5 },
    ]);
    expect(
      await getDb(ctx.db).query.financialTransaction.findMany(),
    ).toHaveLength(1);
  });

  // Preview must fence missing/stale suggestions and invalid drafts before
  // planning, replan the selected draft, and never publish or mutate evidence.
  it("fences missing fingerprints, replaced suggestions, and changed statement evidence in preview", async () => {
    await fixture();
    const suggestion = await pendingPreview();
    const input = {
      suggestionId: suggestion.suggestionId,
      expectedFingerprint: suggestion.fingerprint ?? suggestion.suggestionId,
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
        suggestionId: crypto.randomUUID(),
      }),
    ).rejects.toThrow(/no longer available/i);
    await expect(
      previewStatementSuggestion(ctx.db, {
        ...input,
        expectedFingerprint: "synthetic-stale",
      }),
    ).rejects.toThrow(/changed since review/i);
    await getDb(ctx.db).execute(
      sql`UPDATE "SourceTransactionRecord" SET "rawDescription" = 'SYNTHETIC CHANGED EVIDENCE'`,
    );
    await expect(previewStatementSuggestion(ctx.db, input)).rejects.toThrow(
      /changed since review: create.rawDescription/i,
    );
  });
  it("replans draft kind and booking without writing transactions, vendors, aliases, or suggestion state", async () => {
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
        'advice', (SELECT jsonb_agg(to_jsonb(v)) FROM "Suggestion" v)
      ) AS state
    `)
      ).rows[0]!.state;
    const before = await snapshot();
    const input = {
      suggestionId: suggestion.suggestionId,
      expectedFingerprint: suggestion.fingerprint ?? suggestion.suggestionId,
      application: {
        kind: "statement_transaction",
        action: "create",
        booking: {
          spendingCategoryId: advice.spendingCategoryId,
          reviewedVendorName: "Synthetic Orchard",
          costType: "services",
        },
      },
    };
    const result = await previewStatementSuggestion(ctx.db, input);
    expect(result).toMatchObject({
      action: "create",
      kind: "purchase",
      spending: {
        status: "ready",
        effect: "create_aggregate",
        request: { costType: "services" },
      },
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
      where: {
        RAW: (table: PgTable) =>
          relationalSql(table, isNull(vendorTable.systemKey)),
      },
    });
    const purchase = await createRepoEntity(ctx, "purchase", {
      vendorId: vendor!.shortcode,
      date: "2026-05-04",
      statedTotal: 42.5,
    });
    const suggestion = await pendingPreview();
    const input = {
      suggestionId: suggestion.suggestionId,
      expectedFingerprint: suggestion.fingerprint ?? suggestion.suggestionId,
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
    await reviewSuggestion(ctx.db, kernelCtx(ctx), {
      suggestionId: suggestion.suggestionId,
      operationId: "synthetic-preview-attach",
      verdict: "wrong",
      correction: {
        present: true,
        value: statementTransactionApplication.parse(application),
      },
      expectedFingerprint: suggestion.fingerprint ?? suggestion.suggestionId,
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
      where: {
        RAW: (table: PgTable) =>
          relationalSql(table, isNull(vendorTable.systemKey)),
      },
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
      suggestionId: suggestion.suggestionId,
      expectedFingerprint: suggestion.fingerprint ?? suggestion.suggestionId,
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
    const { input, account, recorded } = await fixture(
      "synthetic-category-charge",
    );
    await recordSourceTransactionRecords(
      ctx.db,
      recordSourceTransactionRecordsInput.parse({
        ...input,
        import: { ...input.import, fingerprint: "synthetic-category-reexport" },
        rows: [{ ...input.rows[0], sourceCategory: "Food and drink" }],
      }),
      ctx.actor,
    );
    const revisions = await getDb(ctx.db)
      .select(sourceObservationColumns)
      .from(sourceObservationFrom);
    const previous = revisions.find(
      (row) => row.sourceCategory === "Groceries",
    );
    const current = revisions.find(
      (row) => row.sourceCategory === "Food and drink",
    );
    if (!previous || !current)
      throw new Error("Synthetic source category revision missing");
    await updateSourceTransactionRecords(
      ctx.db,
      {
        selector: {
          source: previous.source,
          externalIds: [previous.externalId],
        },
        data: { supersededByExternalId: current.externalId },
      },
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
            providerData: {
              id: "synthetic-unrelated-charge",
              account_id: "synthetic-statement-account",
            },
            sourceCategory: "Unrelated category",
          },
        ],
      }),
      ctx.actor,
    );
    await generateStatementSuggestionPage(ctx.db, {
      servicesFor: buildCrudServices,
      after: null,
      runId: null,
      scope: { importId: recorded.batchId! },
    });
    const states = await getDb(ctx.db).query.suggestionTable.findMany();
    const suggestions = await readStatementSuggestions(
      ctx.db,
      states.map((state) => state.id),
    );
    expect(suggestions).toHaveLength(1);
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
        rows: [
          {
            ...input.rows[0],
            providerTransactionId: null,
            providerAccountId: null,
            providerData: null,
            sourceCategory: "Dining",
          },
        ],
      }),
      ctx.actor,
    );
    const observations = (await listSourceTransactionRecords(ctx.db, {})).data;
    const primary = observations.find(
      (row) =>
        row.source === "monarch" &&
        row.statementDate === "2026-05-04" &&
        row.current,
    )!;
    const secondProvider = observations.find(
      (row) => row.source === "copilot",
    )!;
    expect(
      (await readStatementSuggestions(ctx.db, [suggestion.suggestionId]))[0]!
        .sourceCategories,
    ).toEqual([
      { source: "monarch", sourceCategory: "Food and drink" },
      { source: "monarch", sourceCategory: "Groceries" },
    ]);
    for (const row of [primary, secondProvider]) {
      await updateSourceTransactionRecords(
        ctx.db,
        {
          selector: { source: row.source, externalIds: [row.externalId] },
          data: { accountId: account.output.id },
        },
        ctx.actor,
      );
    }
    const transaction = await createRepoEntity(ctx, "financialTransaction", {
      accountId: account.output.id,
      kind: "purchase",
      status: "posted",
      amount: 42.5,
      postedDate: "2026-05-04",
      merchant: "Synthetic Orchard",
      sourceRefs: [primary, secondProvider].map((row) => ({
        source: row.source,
        externalId: row.chargeKey,
      })),
    });

    expect(
      await readStatementSuggestions(ctx.db, [suggestion.suggestionId]),
    ).toEqual([]);
    // Shared settlement refs establish cross-provider membership; the stale
    // create suggestion is replaced by pending booking work for that charge.
    await generateStatementSuggestionPage(ctx.db, {
      servicesFor: buildCrudServices,
      after: null,
      runId: null,
    });
    const refreshedStates = await getDb(
      ctx.db,
    ).query.suggestionTable.findMany();
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
  it("refuses a clean spending suggestion when older partly paid spending appears", async () => {
    const { account, advice } = await fixture();
    await labelAndRefreshReads(advice);
    const page = await listSuggestionPage(ctx.db, {
      family: "statement_transaction",
      limit: 20,
    });
    const suggestion = page.items.find(
      (row) => row.family === "statement_transaction",
    );
    expect(suggestion?.clean).toBe(true);
    const vendor = await getDb(ctx.db).query.vendor.findFirst({
      where: {
        RAW: (table: PgTable) =>
          relationalSql(table, eq(vendorTable.name, "Synthetic Orchard")),
      },
    });
    const receipt = await createRepoEntity(ctx, "purchase", {
      vendorId: vendor!.shortcode,
      date: "2026-03-01",
    });
    await createRepoEntity(ctx, "expense", {
      purchaseId: receipt.output.id,
      name: "Synthetic older receipt",
      cost: 40,
      trade: "other",
    });
    // An installment-style first payment leaves the older receipt open.
    const installment = await createRepoEntity(ctx, "financialTransaction", {
      accountId: account.output.id,
      kind: "purchase",
      status: "posted",
      amount: 10,
      postedDate: "2026-03-01",
      allocations: [{ purchaseId: receipt.output.id, amount: 10 }],
    });
    await expect(
      reviewSuggestion(ctx.db, kernelCtx(ctx), {
        suggestionId: suggestion!.id,
        operationId: "synthetic-spending-accept",
        verdict: "correct",
        intent: "apply",
        application: {
          kind: "statement_transaction",
          action: "create",
          rejectedCandidateIds: [],
          fields: [],
        },
      }),
    ).rejects.toThrow(/changed|review|stale/i);
    expect(await total()).toBe(40);
    expect(
      (await getDb(ctx.db).query.financialTransaction.findMany()).map(
        (row) => row.shortcode,
      ),
    ).toEqual([installment.output.id]);
  });
  it("republishes drifted clean spending instead of refusing it on every import pass", async () => {
    const { account, advice: merchantAdvice, input } = await fixture();
    // The advice names a Vendor the merchant text alone does not resolve to,
    // so adviceless rule evidence cannot see that Vendor's spending.
    await createRepoEntity(ctx, "vendor", { name: "Synthetic Grove Holdings" });
    const advice = financialSpendingAdvice.parse({
      ...merchantAdvice,
      vendorName: "Synthetic Grove Holdings",
    });
    const recorded = await recordSourceTransactionRecords(
      ctx.db,
      recordSourceTransactionRecordsInput.parse({
        import: { ...input.import, fingerprint: "synthetic-spending-grove" },
        rows: [
          {
            ...input.rows[0]!,
            statementDate: "2026-05-11",
            providerAmount: -17.25,
            merchant: "SQ SYNTH GRV 042",
            rawDescription: "SQ *SYNTH GRV 042",
            rowPosition: 2,
          },
        ],
      }),
      ctx.actor,
    );
    await labelAndRefreshReads(advice);
    const published = async () => {
      const [state] = await getDb(ctx.db)
        .select({
          id: suggestionTable.id,
          producer: suggestionTable.producer,
          judgment: suggestionTable.judgment,
          data: suggestionTable.data,
        })
        .from(suggestionTable)
        .where(
          sql`${suggestionTable.active} AND ${suggestionTable.status} = ${suggestionStatus.enum.pending}
            AND ${suggestionTable.data}->>'statementDate' = '2026-05-11'`,
        );
      return state!;
    };
    const before = await published();
    expect(before.judgment).toMatchObject({
      spending: { status: "ready", effect: "create_aggregate" },
    });
    // Another writer leaves an open Purchase for the same Vendor afterwards.
    const vendor = await getDb(ctx.db).query.vendor.findFirst({
      where: {
        RAW: (table: PgTable) =>
          relationalSql(
            table,
            eq(vendorTable.name, "Synthetic Grove Holdings"),
          ),
      },
    });
    const receipt = await createRepoEntity(ctx, "purchase", {
      vendorId: vendor!.shortcode,
      date: "2026-03-01",
    });
    await createRepoEntity(ctx, "expense", {
      purchaseId: receipt.output.id,
      name: "Synthetic older receipt",
      cost: 40,
      trade: "other",
    });
    await createRepoEntity(ctx, "financialTransaction", {
      accountId: account.output.id,
      kind: "purchase",
      status: "posted",
      amount: 10,
      postedDate: "2026-03-01",
      allocations: [{ purchaseId: receipt.output.id, amount: 10 }],
    });
    const refusals = vi.spyOn(
      statementApplication,
      "currentStatementApplication",
    );
    try {
      const pass = () =>
        generateStatementSuggestionPage(ctx.db, {
          servicesFor: buildCrudServices,
          after: null,
          runId: null,
          scope: { importId: recorded.batchId },
        });
      expect(await pass()).toMatchObject({ published: 1, failed: [] });
      // Converged: the next pass leaves the republished booking unchanged.
      expect(await pass()).toMatchObject({ published: 0, failed: [] });
      // The drifted booking is republished with current terms, keeping the
      // paid advice and model provenance; it is never admitted as published.
      const after = await published();
      expect(after.id).not.toBe(before.id);
      expect(after.producer).toMatchObject({ kind: "model" });
      expect(after.judgment).not.toMatchObject({
        spending: { status: "ready", effect: "create_aggregate" },
      });
      expect(after.judgment).toMatchObject({
        spending: { request: { advice } },
      });
      expect(refusals).not.toHaveBeenCalled();
      expect(await total()).toBe(40);
    } finally {
      refusals.mockRestore();
    }
  });
  it("books matched historical evidence once, retains its audit and skips later Expense edits", async () => {
    const { input, account, advice, recorded } = await fixture();
    const observed = (await listSourceTransactionRecords(ctx.db, {})).data[0]!;
    await updateSourceTransactionRecords(
      ctx.db,
      {
        selector: {
          source: observed.source,
          externalIds: [observed.externalId],
        },
        data: { accountId: account.output.id },
      },
      ctx.actor,
    );
    await createRepoEntity(ctx, "financialTransaction", {
      accountId: account.output.id,
      kind: "purchase",
      status: "posted",
      amount: 42.5,
      postedDate: "2026-05-04",
      merchant: "Synthetic Orchard",
      rawDescription: "SYNTHETIC ORCHARD",
      sourceRefs: [{ source: "monarch", externalId: observed.chargeKey }],
    });
    const repeated = await recordSourceTransactionRecords(
      ctx.db,
      input,
      ctx.actor,
    );
    expect(repeated.inserted).toBe(0);
    // The accepted transaction owns identity even when historical position metadata is absent.
    await getDb(ctx.db)
      .update(sourceTransactionRecord)
      .set({ rowPosition: null })
      .where(eq(sourceTransactionRecord.shortcode, observed.id));
    await labelAndRefreshReads(advice, recorded.batchId!);
    expect(await total()).toBe(42.5);
    await labelAndRefreshReads(advice, recorded.batchId!);
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
    ).toBe(false);
    await executeEntity(
      kernelCtx(ctx),
      entityCommandSchema.parse({
        action: "update",
        entity: "expense",
        id: bookedExpense!.shortcode,
        data: { name: "Synthetic member-corrected expense title" },
      }),
    );
    await labelAndRefreshReads(advice, recorded.batchId!);
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
    await labelAndRefreshReads(advice);
    const suggestion = (
      await listSuggestionPage(ctx.db, {
        family: "statement_transaction",
        limit: 20,
      })
    ).items[0]!;
    const vendor = await getDb(ctx.db).query.vendor.findFirst({
      where: {
        RAW: (table: PgTable) =>
          relationalSql(table, isNull(vendorTable.systemKey)),
      },
    });
    const application = statementTransactionApplication.parse({
      kind: "statement_transaction",
      action: "create",
      booking: { vendorId: vendor!.shortcode },
    });
    await reviewSuggestion(ctx.db, kernelCtx(ctx), {
      suggestionId: suggestion.id,
      operationId: "synthetic-vendor-only-review",
      verdict: "wrong",
      correction: { present: true, value: application },
      intent: "apply",
      expectedFingerprint: suggestion.fingerprint ?? suggestion.id,
      application,
    });
    expect(await total()).toBe(42.5);
  });
  it("retires a pending matched booking when another shared finance path books it", async () => {
    const { advice, account } = await fixture();
    const row = (await listSourceTransactionRecords(ctx.db, {})).data[0]!;
    await updateSourceTransactionRecords(
      ctx.db,
      {
        selector: { source: row.source, externalIds: [row.externalId] },
        data: { accountId: account.output.id },
      },
      ctx.actor,
    );
    const transaction = await createRepoEntity(ctx, "financialTransaction", {
      accountId: account.output.id,
      kind: "purchase",
      status: "posted",
      amount: 42.5,
      postedDate: "2026-05-04",
      merchant: "Synthetic Orchard",
      sourceRefs: [{ source: "monarch", externalId: row.chargeKey }],
    });
    await labelAndRefreshReads(advice);
    expect(
      (
        await listSuggestionPage(ctx.db, {
          family: "statement_transaction",
          limit: 20,
        })
      ).items,
    ).toHaveLength(1);
    const vendor = await getDb(ctx.db).query.vendor.findFirst({
      where: {
        RAW: (table: PgTable) =>
          relationalSql(table, isNull(vendorTable.systemKey)),
      },
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
    await generateStatementSuggestionPage(ctx.db, {
      servicesFor: buildCrudServices,
      after: null,
      runId: null,
    });
    await drainStoredDerived(ctx.db);
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
  // Creating one Vendor must not invalidate other independent clean charges
  // or strand paid advice outside the label queue across import pages.
  it("books independent new Vendors across import pages and reuses unchanged advice", async () => {
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
    const generateImport = async () => {
      let after: Parameters<
        typeof generateStatementSuggestionPage
      >[1]["after"] = null;
      do {
        const page = await generateStatementSuggestionPage(ctx.db, {
          servicesFor: buildCrudServices,
          after,
          runId: null,
          scope: { importId: saved.batchId! },
        });
        after = page.next;
      } while (after);
    };
    await generateImport();
    let after: Awaited<ReturnType<typeof labelStatementSuggestions>>["next"] =
      null;
    do {
      const labelled = await labelStatementSuggestions(ctx.db, {
        after,
        port: answering({ kind: "purchase", counterparty: "business" }),
        spendingAdvice: async ({ judgment }) => ({
          ...advice,
          vendorName: judgment.create!.merchant,
        }),
        scope: { importId: saved.batchId! },
      });
      expect(labelled.failed).toEqual([]);
      after = labelled.next;
    } while (after);
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
    await generateImport();
    expect(await total()).toBe(165);
  });
});
