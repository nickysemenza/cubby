import { financialBookingInput } from "@cubby/schemas/financial-booking";
import { financialSpendingAdvice } from "@cubby/schemas/financial-booking";
import {
  sourceTransactionRecordProviderStatus,
  recordSourceTransactionRecordsInput,
} from "@cubby/schemas/source-transaction-record";
import { statementTransactionApplication } from "@cubby/schemas/statement-suggestion";
import { eq, isNull, sql } from "drizzle-orm";
import { createEntity } from "tooling/factories/create";
import { createRepoEntity } from "tooling/factories/repo";
import { buildKernelContext } from "tooling/scenarios/context";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it, vi } from "vitest";

import { getDb, runAfterCommit } from "~/server/db/helpers";
import {
  assessmentState,
  sourceTransactionRecord,
  vendor as vendorTable,
} from "~/server/db/schema";
import { updateFinancialAccount } from "~/server/domains/financial-account/repo";
import { bookFinancialTransaction } from "~/server/domains/financial-transaction/repo/financial-booking";
import { kernelCtx } from "~/server/domains/run/service/suggestion-sweep.fixtures";
import { labelStatementSuggestions } from "~/server/domains/transaction-import/service/statement-suggestion-labels";
import { executeEntity } from "~/server/entity-kernel";
import { entityCommandSchema } from "~/server/entity-kernel/contracts";
import { reviewAssessment } from "~/server/generic/assessment/repo/assessment-review";
import { listAutomaticDecisions } from "~/server/generic/assessment/repo/automatic-decisions";
import { applyAutomaticRules } from "~/server/generic/assessment/repo/automatic-rule-runtime";
import { listSuggestionPage } from "~/server/generic/assessment/repo/suggestion-list";
import * as changes from "~/server/generic/changes/repo/change";
import {
  lockJobs,
  replaceJobGeneration,
} from "~/server/generic/jobs/jobs.fixtures";
import { enqueueJob } from "~/server/generic/jobs/repo/producer";

import { recordSourceTransactionRecords } from "./source-transaction-record";
import { listSourceTransactionRecords } from "./source-transaction-record.fixtures";
import { answering } from "./statement-decision-port.fixtures";
import * as statementApplication from "./statement-suggestion-application";
import { previewStatementSuggestion } from "./statement-suggestion-preview";
import { readStatementSuggestions } from "./statement-suggestion-read";
import {
  buildChargeProposals,
  buildHoldVoidProposals,
  generateStatementHoldVoidPage,
  generateStatementSuggestionPage,
} from "./statement-suggestions";

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
      scope: { importId },
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
  it.each(["once", "exhausted", "stale", "committed"] as const)(
    "preserves shared-card application and replay after %s contention",
    async (mode) => {
      const { advice, account } = await fixture(null, "household");
      await label(advice);
      const page = await listSuggestionPage(ctx.db, {
        family: "statement_transaction",
        limit: 20,
      });
      const suggestion = page.items[0]!;
      const command = {
        assessmentId: suggestion.id,
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
          assessmentId: command.assessmentId,
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
      (SELECT count(*)::int FROM "Feedback" WHERE "assessmentId" = ${suggestion.id}::uuid) AS "totalFeedback",
      (SELECT count(*)::int FROM "Feedback" WHERE "assessmentId" = ${suggestion.id}::uuid AND "operationId" IN (${command.operationId}, ${`command-application:${command.operationId}`})) AS feedback`)
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
            const result = await reviewAssessment(
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
              reviewAssessment(ctx.db, kernelCtx(ctx), command),
            ).rejects.toMatchObject({ cause: { code: "40001" } });
            expect(calls).toBe(3);
            expect(builds).toBe(3);
            expect(await read()).toEqual({
              ...before,
              feedback: before.feedback + 1,
              totalFeedback: before.totalFeedback + 1,
            });
            expect(
              await getDb(ctx.db).query.assessmentState.findFirst({
                where: eq(assessmentState.id, suggestion.id),
              }),
            ).toMatchObject({ active: true, status: "pending" });
            racing.mockRestore();
            return reviewAssessment(ctx.db, kernelCtx(ctx), command);
          },
          stale: async () => {
            await expect(
              reviewAssessment(ctx.db, kernelCtx(ctx), command),
            ).rejects.toThrow(/statement or transaction evidence changed/i);
            expect(builds).toBe(2);
            expect(await read()).toEqual({
              ...before,
              feedback: before.feedback + 1,
              totalFeedback: before.totalFeedback + 1,
            });
            expect(
              await getDb(ctx.db).query.assessmentState.findFirst({
                where: eq(assessmentState.id, suggestion.id),
              }),
            ).toMatchObject({ active: true, status: "pending" });
            return;
          },
          committed: async () => {
            await expect(
              reviewAssessment(ctx.db, kernelCtx(ctx), command),
            ).rejects.toThrow(
              /Transaction committed, but an after-commit effect failed/,
            );
            expect(calls).toBe(1);
            expect(builds).toBe(1);
            racing.mockRestore();
            const result = await reviewAssessment(
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
          totalFeedback: before.totalFeedback + 3,
        });
        expect(
          await getDb(ctx.db).query.assessmentState.findFirst({
            where: eq(assessmentState.id, suggestion.id),
          }),
        ).toMatchObject({ status: "applied" });
        const stored = await read();
        expect(await reviewAssessment(ctx.db, kernelCtx(ctx), command)).toEqual(
          result,
        );
        expect(await read()).toEqual(stored);
      } finally {
        racing.mockRestore();
        rebuilding.mockRestore();
      }
    },
  );
  async function providerHistory(
    input: ReturnType<typeof recordSourceTransactionRecordsInput.parse>,
  ) {
    const aliases = [
      {
        source: "monarch",
        alias: "Synthetic card 4242",
        externalAccountId: null,
      },
      {
        source: "monarch",
        alias: "Synthetic long card 4242",
        externalAccountId: "synthetic-account",
      },
    ];
    await getDb(ctx.db).execute(
      sql`UPDATE "FinancialAccount" SET "sourceAliases" = ${JSON.stringify(aliases)}::jsonb`,
    );
    await recordSourceTransactionRecords(
      ctx.db,
      recordSourceTransactionRecordsInput.parse({
        ...input,
        import: { ...input.import, fingerprint: "synthetic-provider-scope" },
        rows: [
          {
            ...input.rows[0],
            accountDescriptor: "Synthetic long card 4242",
            providerTransactionId: "synthetic-other-provider-id",
            providerAccountId: "synthetic-account",
          },
        ],
      }),
      ctx.actor,
    );
    await recordSourceTransactionRecords(
      ctx.db,
      recordSourceTransactionRecordsInput.parse({
        ...input,
        import: { ...input.import, fingerprint: "synthetic-provider-revision" },
        rows: [
          {
            ...input.rows[0],
            accountDescriptor: "Synthetic long card 4242",
            providerTransactionId: "synthetic-other-provider-id",
            providerAccountId: "synthetic-account",
            providerNotes: "Synthetic newer observation",
          },
        ],
      }),
      ctx.actor,
    );
    // Historical retained keys cannot be constructed by today's guarded intake.
    await getDb(ctx.db).execute(
      sql`UPDATE "SourceTransactionRecord" SET "providerTransactionId" = 'synthetic-shared-provider-id' WHERE "providerTransactionId" IS NULL`,
    );
  }
  const providerCollision = () =>
    getDb(ctx.db).execute(
      sql`UPDATE "SourceTransactionRecord" SET "providerTransactionId" = 'synthetic-shared-provider-id' WHERE "providerTransactionId" = 'synthetic-other-provider-id'`,
    );

  const chargeRefs = async () =>
    (
      await getDb(ctx.db).execute<{ source: string; chargeKey: string }>(
        sql`SELECT DISTINCT source, "chargeKey" FROM "SourceTransactionRecord"`,
      )
    ).rows;
  it("holds compatible provider keys from either account representation in direct and page discovery", async () => {
    const { input } = await fixture();
    await providerHistory(input);
    await providerCollision();
    const charges = await chargeRefs();
    expect(charges).toHaveLength(2);
    const together = await buildChargeProposals(ctx.db, charges);
    for (const charge of charges) {
      const [direct] = await buildChargeProposals(ctx.db, [charge]);
      expect(direct?.judgment).toEqual(
        together.find(
          (proposal) => proposal.charge.chargeKey === charge.chargeKey,
        )?.judgment,
      );
      expect(direct?.judgment).toMatchObject({
        clean: false,
        reviewReason: expect.stringMatching(/provider identity/i),
      });
    }
    await generateStatementSuggestionPage(ctx.db, { after: null, runId: null });
    const states = await getDb(ctx.db).query.assessmentState.findMany();
    expect(
      await readStatementSuggestions(
        ctx.db,
        states.map((state) => state.id),
      ),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          clean: false,
          reviewReason: expect.stringMatching(/provider identity/i),
        }),
      ]),
    );
  });
  it.each([false, true])(
    "refuses a retained clean proposal after provider collision, previewed=%s",
    async (previewed) => {
      const { input, advice, account } = await fixture();
      await providerHistory(input);
      if (previewed) {
        const legacy = (
          await getDb(ctx.db).query.sourceTransactionRecord.findMany()
        ).find((row) => row.providerAccountId === null)!;
        await createRepoEntity(ctx, "financialTransaction", {
          accountId: account.output.id,
          kind: "purchase",
          status: "posted",
          amount: 42.5,
          postedDate: "2026-05-04",
          merchant: "Synthetic Orchard",
          sourceRefs: [
            { source: legacy.source, externalId: legacy.externalId },
          ],
        });
      }
      await label(advice);
      const suggestions = await readStatementSuggestions(
        ctx.db,
        (await getDb(ctx.db).query.assessmentState.findMany()).map(
          (state) => state.id,
        ),
      );
      const suggestion = suggestions.find(
        (item) => item.recommended === (previewed ? "book" : "create"),
      );
      expect(suggestion?.clean).toBe(true);
      const draft = {
        assessmentId: suggestion!.assessmentId,
        expectedFingerprint: suggestion!.fingerprint,
        application: {
          kind: "statement_transaction",
          action: previewed ? "book" : "create",
        },
      };
      if (previewed) await previewStatementSuggestion(ctx.db, draft);
      await providerCollision();
      const automatic = await applyAutomaticRules(
        ctx.db,
        [suggestion!.assessmentId],
        { context: kernelCtx(ctx), importClean: true },
      );
      expect(automatic.applied).toEqual([]);
      expect(automatic.refused).toEqual([
        expect.objectContaining({
          assessmentId: suggestion!.assessmentId,
          message: expect.stringMatching(/evidence changed|provider identity/i),
        }),
      ]);
      const before = (
        await getDb(ctx.db).execute<{ snapshot: unknown }>(
          sql`SELECT jsonb_build_object(
            'rows', (SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM "SourceTransactionRecord" r),
            'transactions', (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM "FinancialTransaction" t),
            'refs', (SELECT jsonb_agg(to_jsonb(e) ORDER BY id) FROM "EntityExternalId" e)
          ) AS snapshot`,
        )
      ).rows[0]!.snapshot;
      await expect(previewStatementSuggestion(ctx.db, draft)).rejects.toThrow(
        /evidence changed|provider identity/i,
      );
      await expect(
        reviewAssessment(ctx.db, kernelCtx(ctx), {
          assessmentId: suggestion!.assessmentId,
          expectedFingerprint: suggestion!.fingerprint,
          operationId: "synthetic-held-provider-command",
          verdict: "correct",
          intent: "apply",
          application: statementTransactionApplication.parse(draft.application),
        }),
      ).rejects.toThrow(/evidence changed|provider identity/i);
      expect(
        await getDb(ctx.db).query.financialTransaction.findMany(),
      ).toHaveLength(previewed ? 1 : 0);
      expect(await getDb(ctx.db).query.expense.findMany()).toHaveLength(0);
      expect(
        await getDb(ctx.db).query.financialTransactionAllocation.findMany(),
      ).toHaveLength(0);
      expect(
        (
          await getDb(ctx.db).execute<{ snapshot: unknown }>(
            sql`SELECT jsonb_build_object(
            'rows', (SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM "SourceTransactionRecord" r),
            'transactions', (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM "FinancialTransaction" t),
            'refs', (SELECT jsonb_agg(to_jsonb(e) ORDER BY id) FROM "EntityExternalId" e)
          ) AS snapshot`,
          )
        ).rows[0]!.snapshot,
      ).toEqual(before);
      const feedback = await getDb(ctx.db).query.feedback.findMany();
      expect(feedback).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            operationId: "synthetic-held-provider-command",
          }),
        ]),
      );
      expect(
        feedback.some(
          (event) =>
            event.operationId ===
            "command-application:synthetic-held-provider-command",
        ),
      ).toBe(false);
    },
  );
  it.each([
    "distinct_account",
    "other_provider_id",
    "positioned_idless",
    "retired_known_scope",
  ])("preserves provider scope independence: %s", async (scenario) => {
    const { input, advice } = await fixture();
    await providerHistory(input);
    if (scenario === "distinct_account") {
      const owner = await createRepoEntity(ctx, "ledgerParty", {
        name: "Synthetic second cardholder",
        kind: "member",
      });
      await createRepoEntity(ctx, "financialAccount", {
        name: "Synthetic independent card",
        identity: { kind: "credit_card", network: "visa" },
        ledgerPartyId: owner.output.id,
        sourceAliases: [
          {
            source: "monarch",
            alias: "Synthetic card 4242",
            externalAccountId: "synthetic-other-account",
          },
        ],
      });
      await getDb(ctx.db).execute(
        sql`UPDATE "SourceTransactionRecord" SET "providerAccountId" = 'synthetic-other-account' WHERE "providerAccountId" IS NULL`,
      );
      await providerCollision();
    } else if (scenario === "retired_known_scope") {
      const retained = await getDb(
        ctx.db,
      ).query.sourceTransactionRecord.findMany();
      const legacy = retained.find((row) => row.providerAccountId === null)!;
      const historical = retained.find((row) => !row.current)!;
      // Even a removed older known scope prevents a current null scope from
      // bridging the provider ID into a different known account (ABA).
      await getDb(ctx.db).execute(
        sql`UPDATE "SourceTransactionRecord" SET "chargeKey" = ${legacy.chargeKey}, "providerAccountId" = 'synthetic-retired-account', "providerTransactionId" = 'synthetic-shared-provider-id', "deletedAt" = now() WHERE id = ${historical.id}::uuid`,
      );
      await providerCollision();
    } else if (scenario === "positioned_idless") {
      await getDb(ctx.db).execute(
        sql`UPDATE "SourceTransactionRecord" SET "providerTransactionId" = NULL WHERE "providerAccountId" IS NULL`,
      );
    }
    const proposals = await buildChargeProposals(ctx.db, await chargeRefs());
    expect(proposals).toHaveLength(2);
    expect(
      proposals.every((proposal) => proposal.judgment.reviewReason === null),
    ).toBe(true);
    await label(advice);
    const suggestions = await readStatementSuggestions(
      ctx.db,
      (await getDb(ctx.db).query.assessmentState.findMany()).map(
        (state) => state.id,
      ),
    );
    expect(suggestions).toHaveLength(2);
    expect(suggestions.every((suggestion) => suggestion.clean)).toBe(true);
  });
  it.each(["superseded", "deleted", "withdrawn"])(
    "keeps unresolved provider successor histories held: %s",
    async (state) => {
      const { input } = await fixture();
      await providerHistory(input);
      await providerCollision();
      const legacy = (
        await getDb(ctx.db).query.sourceTransactionRecord.findMany()
      ).find((row) => row.providerAccountId === null)!;
      if (state === "superseded")
        await getDb(ctx.db).execute(
          sql`UPDATE "SourceTransactionRecord" SET "supersededByRowId" = (SELECT id FROM "SourceTransactionRecord" WHERE "providerAccountId" IS NOT NULL AND current LIMIT 1) WHERE id = ${legacy.id}::uuid`,
        );
      if (state === "deleted")
        await getDb(ctx.db).execute(
          sql`UPDATE "SourceTransactionRecord" SET "deletedAt" = now() WHERE id = ${legacy.id}::uuid`,
        );
      if (state === "withdrawn")
        await getDb(ctx.db).execute(
          sql`UPDATE "SourceTransactionRecord" SET "withdrawnAt" = now() WHERE id = ${legacy.id}::uuid`,
        );
      const known = (await chargeRefs()).find(
        (charge) => charge.chargeKey !== legacy.chargeKey,
      )!;
      const [proposal] = await buildChargeProposals(ctx.db, [known]);
      expect(proposal?.judgment).toMatchObject({
        clean: false,
        reviewReason: expect.stringMatching(/provider identity/i),
      });
    },
  );
  it("replays the exact successful canonical receipt before a later provider collision", async () => {
    const { input, advice } = await fixture();
    await providerHistory(input);
    await label(advice);
    const [suggestion] = await readStatementSuggestions(
      ctx.db,
      (await getDb(ctx.db).query.assessmentState.findMany()).map(
        (state) => state.id,
      ),
    );
    const command = {
      assessmentId: suggestion!.assessmentId,
      expectedFingerprint: suggestion!.fingerprint,
      operationId: "synthetic-canonical-provider-replay",
      verdict: "correct" as const,
      intent: "apply" as const,
      application: statementTransactionApplication.parse({
        kind: "statement_transaction",
        action: "create",
      }),
    };
    const receipt = await reviewAssessment(ctx.db, kernelCtx(ctx), command);
    await providerCollision();
    expect(await reviewAssessment(ctx.db, kernelCtx(ctx), command)).toEqual(
      receipt,
    );
    expect(await total()).toBe(42.5);
    expect(
      await getDb(ctx.db).query.financialTransaction.findMany(),
    ).toHaveLength(1);
    expect(
      await getDb(ctx.db).query.financialTransactionAllocation.findMany(),
    ).toHaveLength(1);
  });
  it("refuses paid label publication when provider identity changes during preparation", async () => {
    const { input, advice } = await fixture();
    await providerHistory(input);
    await generateStatementSuggestionPage(ctx.db, { after: null, runId: null });
    const answer = answering({ kind: "purchase", counterparty: "business" });
    let changed = false;
    const result = await labelStatementSuggestions(ctx.db, {
      port: async (request) => {
        if (!changed) {
          changed = true;
          await providerCollision();
        }
        return answer(request);
      },
      spendingAdvice: async () => advice,
    });
    expect(result.completed).toBe(0);
    expect(result.failed.length).toBeGreaterThan(0);
    await generateStatementSuggestionPage(ctx.db, { after: null, runId: null });
    const suggestions = await readStatementSuggestions(
      ctx.db,
      (await getDb(ctx.db).query.assessmentState.findMany()).map(
        (state) => state.id,
      ),
    );
    expect(
      suggestions.every(
        (suggestion) => !suggestion.clean && Boolean(suggestion.reviewReason),
      ),
    ).toBe(true);
    expect(
      await getDb(ctx.db).query.financialTransaction.findMany(),
    ).toHaveLength(0);
  });
  it("rechecks mutable account aliases after preview before applying a provider key", async () => {
    const { input, advice } = await fixture();
    await providerHistory(input);
    const account = (await getDb(ctx.db).query.financialAccount.findMany())[0]!;
    const owner = await createRepoEntity(ctx, "ledgerParty", {
      name: "Synthetic alias holder",
      kind: "member",
    });
    await getDb(ctx.db).execute(
      sql`UPDATE "FinancialAccount" SET "sourceAliases" = '[{"source":"monarch","alias":"Synthetic card 4242","externalAccountId":null}]'::jsonb WHERE id = ${account.id}::uuid`,
    );
    const other = await createRepoEntity(ctx, "financialAccount", {
      name: "Synthetic separate alias card",
      identity: { kind: "credit_card", network: "visa" },
      ledgerPartyId: owner.output.id,
      sourceAliases: [
        {
          source: "monarch",
          alias: "Synthetic long card 4242",
          externalAccountId: "synthetic-account",
        },
      ],
    });
    await providerCollision();
    await label(advice);
    const legacy = (
      await getDb(ctx.db).query.sourceTransactionRecord.findMany()
    ).find((row) => row.providerAccountId === null)!;
    const suggestion = (
      await readStatementSuggestions(
        ctx.db,
        (await getDb(ctx.db).query.assessmentState.findMany()).map(
          (state) => state.id,
        ),
      )
    ).find((item) => item.chargeKey === legacy.chargeKey)!;
    expect(suggestion.clean).toBe(true);
    const draft = {
      assessmentId: suggestion.assessmentId,
      expectedFingerprint: suggestion.fingerprint,
      application: { kind: "statement_transaction", action: "create" },
    };
    await previewStatementSuggestion(ctx.db, draft);
    // The source and canonical account stay unchanged; alias authority now
    // makes the other retained provider key compatible with this account.
    await getDb(ctx.db).execute(
      sql`UPDATE "FinancialAccount" SET "sourceAliases" = '[]'::jsonb WHERE shortcode = ${other.output.id}`,
    );
    await getDb(ctx.db).execute(
      sql`UPDATE "FinancialAccount" SET "sourceAliases" = '[{"source":"monarch","alias":"Synthetic card 4242","externalAccountId":null},{"source":"monarch","alias":"Synthetic long card 4242","externalAccountId":"synthetic-account"}]'::jsonb WHERE id = ${account.id}::uuid`,
    );
    await expect(
      reviewAssessment(ctx.db, kernelCtx(ctx), {
        assessmentId: suggestion.assessmentId,
        expectedFingerprint: suggestion.fingerprint,
        operationId: "synthetic-alias-collision",
        verdict: "correct",
        intent: "apply",
        application: statementTransactionApplication.parse(draft.application),
      }),
    ).rejects.toThrow(/evidence changed|provider identity/i);
    expect(
      await getDb(ctx.db).query.financialTransaction.findMany(),
    ).toHaveLength(0);
    expect(await getDb(ctx.db).query.expense.findMany()).toHaveLength(0);
  });
  it.each([false, true])(
    "preserves provider-backed void publication with identity collision=%s",
    async (collision) => {
      const { input, account } = await fixture();
      await providerHistory(input);
      if (collision) await providerCollision();
      const legacy = (
        await getDb(ctx.db).query.sourceTransactionRecord.findMany()
      ).find((row) => row.providerAccountId === null)!;
      await createRepoEntity(ctx, "financialTransaction", {
        accountId: account.output.id,
        kind: "purchase",
        status: "pending",
        amount: 42.5,
        transactionDate: "2026-05-04",
        merchant: "Synthetic Orchard",
        sourceRefs: [{ source: legacy.source, externalId: legacy.externalId }],
      });
      const coverage = await recordSourceTransactionRecords(
        ctx.db,
        recordSourceTransactionRecordsInput.parse({
          import: {
            ...input.import,
            fingerprint: "synthetic-void-coverage",
            rowCountDeclared: 0,
            coverage: {
              account: "Synthetic card 4242",
              from: "2026-05-01",
              to: "2026-05-20",
              visibility: "all",
            },
          },
          rows: [],
          complete: true,
        }),
        ctx.actor,
      );
      // Retain a historical source-confirmed withdrawal without asking intake to
      // reconcile money; the proposal writer owns the behavior exercised here.
      await getDb(ctx.db).execute(
        sql`UPDATE "SourceTransactionRecord" SET "providerStatus" = ${sourceTransactionRecordProviderStatus.enum.pending}, "withdrawnAt" = now(), "withdrawalImportId" = ${coverage.batchId}::uuid WHERE id = ${legacy.id}::uuid`,
      );
      const [proposal] = await buildHoldVoidProposals(ctx.db);
      expect(proposal?.judgment.recommended).toBe("void");
      expect(Boolean(proposal?.judgment.reviewReason)).toBe(collision);
      const generated = await generateStatementHoldVoidPage(ctx.db, {
        after: null,
        runId: null,
      });
      expect(generated).toMatchObject({ published: 1, failed: [] });
      const [state] = await getDb(ctx.db).query.assessmentState.findMany();
      expect(state).toBeDefined();
      const outcome = await previewStatementSuggestion(ctx.db, {
        assessmentId: state!.id,
        expectedFingerprint: state!.fingerprint,
        application: { kind: "statement_transaction", action: "void" },
      })
        .then((preview) => preview.status)
        .catch((error: unknown) => String(error));
      expect(outcome).toMatch(collision ? /provider identity/i : /^void$/);
    },
  );
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
    await generateStatementSuggestionPage(ctx.db, {
      after: null,
      runId: null,
      scope: { importId: recorded.batchId! },
    });
    const states = await getDb(ctx.db).query.assessmentState.findMany();
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
  it("refuses a clean spending suggestion when older unsettled spending appears", async () => {
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
    const vendor = await getDb(ctx.db).query.vendor.findFirst({
      where: eq(vendorTable.name, "Synthetic Orchard"),
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
    await expect(
      reviewAssessment(ctx.db, kernelCtx(ctx), {
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
      }),
    ).rejects.toThrow(/changed|review|stale/i);
    expect(await total()).toBe(40);
    expect(await getDb(ctx.db).query.financialTransaction.findMany()).toEqual(
      [],
    );
  });
  it("books matched historical evidence once, retains its audit and skips later Expense edits", async () => {
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
    // The accepted transaction owns identity even when historical position metadata is absent.
    await getDb(ctx.db)
      .update(sourceTransactionRecord)
      .set({ rowPosition: null })
      .where(eq(sourceTransactionRecord.shortcode, observed.id));
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
      scope: { importId: saved.batchId! },
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
