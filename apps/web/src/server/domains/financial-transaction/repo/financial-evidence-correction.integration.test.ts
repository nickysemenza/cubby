import { recordSourceTransactionRecordsInput } from "@cubby/schemas/source-transaction-record";
import { and, eq } from "drizzle-orm";
import { createRepoEntity } from "tooling/factories/repo";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { getDb, notDeleted } from "~/server/db/helpers";
import {
  expense,
  financialTransaction,
  financialTransactionAllocation,
  sourceTransactionRecord,
} from "~/server/db/schema";
import { updateExpense } from "~/server/domains/expense/repo/crud";
import { recordSourceTransactionRecords } from "~/server/domains/transaction-import/repo/source-transaction-record";
import { setAutomaticRule } from "~/server/generic/assessment/repo/automatic-rule-runtime";
import { settlementRefsFor } from "~/server/generic/entity-links/repo/entity-external-ids";

import { digestValue, loadFinancialBookingLineage } from "./financial-booking";
import { acceptedAutomaticFacts } from "./financial-convergence";
import {
  type FinancialEvidenceCorrectionInput,
  reconcileFinancialEvidenceCorrection,
} from "./financial-evidence-correction";

// Existing reviewed-correction coverage has no provider amount/withdrawal action.
// These real-DB outcomes protect money, retained evidence and attribution shares.
describe("generated booking evidence corrections", () => {
  const ctx = withTestDb();
  const verify: FinancialEvidenceCorrectionInput["verifyCurrentEvidence"] =
    () => Promise.resolve({ status: "verified" });

  async function fixture(
    postedOnly = false,
    extraReference?: { source: string; externalId: string },
    confirmsMerchant = true,
  ) {
    const owner = await createRepoEntity(ctx, "ledgerParty", {
      kind: "member",
      name: "Synthetic correction member",
    });
    const account = await createRepoEntity(ctx, "financialAccount", {
      name: "Synthetic correction account",
      identity: { kind: "cash" },
      ledgerPartyId: owner.output.id,
    });
    const vendor = await createRepoEntity(ctx, "vendor", {
      name: "Synthetic correction store",
    });
    const purchase = await createRepoEntity(ctx, "purchase", {
      vendorId: vendor.output.id,
      date: "2026-09-01",
    });
    const transaction = await createRepoEntity(ctx, "financialTransaction", {
      accountId: account.output.id,
      kind: "purchase",
      status: postedOnly ? "posted" : "observed",
      amount: 25,
      transactionDate: postedOnly ? null : "2026-09-01",
      postedDate: postedOnly ? "2026-09-01" : null,
      sourceRefs: [
        {
          source: "synthetic-bank",
          externalId:
            "v3:1111111111111111111111111111111111111111111111111111111111111111",
        },
        ...(extraReference ? [extraReference] : []),
      ],
      allocations: [
        { purchaseId: purchase.output.id, amount: 25, confirmsMerchant },
      ],
    });
    const line = await createRepoEntity(ctx, "expense", {
      name: "Synthetic generated lump",
      purchaseId: purchase.output.id,
      date: "2026-09-01",
      cost: 25,
      trade: "other",
      lineKind: "principal",
      lineBasis: "allocation",
      economicRole: "vendor",
      beneficiaries: [{ partyId: owner.output.id, weight: 3 }],
      funders: [{ partyId: owner.output.id, weight: 2 }],
    });
    // Booking provenance is storage-only; all entity defaults come from writers.
    await getDb(ctx.db)
      .update(expense)
      .set({ bookingTransactionCode: transaction.output.id })
      .where(eq(expense.id, line.entityId));
    await getDb(ctx.db)
      .update(financialTransaction)
      .set({
        bookingDecisionFingerprint: `automatic:${await acceptedAutomaticFacts(ctx.db, transaction.output.id)}`,
        bookingExpenseFingerprint: await digestValue(
          await loadFinancialBookingLineage(ctx.db, transaction.output.id),
        ),
      })
      .where(eq(financialTransaction.id, transaction.entityId));
    const retained = await recordSourceTransactionRecords(
      ctx.db,
      recordSourceTransactionRecordsInput.parse({
        import: {
          source: "synthetic-bank",
          label: "Synthetic observations",
          fingerprint: "synthetic-correction",
        },
        rows: [25, 30].map((amount, index) => ({
          rowPosition: index + 1,
          accountDescriptor: "Synthetic cash",
          statementDate: "2026-09-01",
          rawDescription: "Synthetic store",
          providerAmount: -amount,
        })),
      }),
      ctx.actor,
    );
    // This fixture retains historical aliases and revision state predating provider identity intake.
    for (const position of [1, 2])
      await getDb(ctx.db)
        .update(sourceTransactionRecord)
        .set({
          externalId: `v3:${String(position).repeat(64)}`,
          chargeKey: "synthetic-charge",
          current: position === 2,
          accountId: account.entityId,
        })
        .where(
          and(
            eq(sourceTransactionRecord.batchId, retained.batchId!),
            eq(sourceTransactionRecord.rowPosition, position),
          ),
        );
    const input: FinancialEvidenceCorrectionInput = {
      source: "synthetic-bank",
      externalId:
        "v3:2222222222222222222222222222222222222222222222222222222222222222",
      transactionId: transaction.output.id,
      amount: 30,
      verifyCurrentEvidence: verify,
    };
    const lineage = () =>
      loadFinancialBookingLineage(ctx.db, transaction.output.id);
    const money = async () => {
      const stored = await getDb(ctx.db).query.financialTransaction.findFirst({
        where: eq(financialTransaction.id, transaction.entityId),
        with: { allocations: true },
      });
      return {
        amount: stored?.amount,
        status: stored?.status,
        allocations: stored?.allocations
          .filter((row) => row.deletedAt === null)
          .map((row) => row.amount),
        expenses: (await lineage()).lines.map((row) => row.cost),
      };
    };
    return { input, transaction, line, lineage, money };
  }

  it.each([false, true])(
    "corrects a new observation without changing member shares or confirmation (%s)",
    async (confirmsMerchant) => {
      const { input, transaction, lineage, money } = await fixture(
        false,
        undefined,
        confirmsMerchant,
      );
      const before = await lineage();
      expect(
        await reconcileFinancialEvidenceCorrection(ctx.db, input, ctx.actor),
      ).toEqual({ status: "corrected", reason: "amount_changed" });
      expect(await money()).toEqual({
        amount: 30,
        status: "observed",
        allocations: [30],
        expenses: [30],
      });
      expect(
        (await lineage()).attributions.map((row) => row.ExpenseAttribution),
      ).toEqual(before.attributions.map((row) => row.ExpenseAttribution));
      expect(
        (
          await getDb(ctx.db).query.financialTransactionAllocation.findMany({
            where: and(
              eq(
                financialTransactionAllocation.transactionId,
                transaction.entityId,
              ),
              notDeleted(financialTransactionAllocation),
            ),
            columns: { confirmsMerchant: true },
          })
        ).map((row) => row.confirmsMerchant),
      ).toEqual([confirmsMerchant]);
      expect(await settlementRefsFor(ctx.db, [transaction.entityId])).toEqual(
        new Map([
          [
            transaction.entityId,
            [
              {
                source: "synthetic-bank",
                externalId:
                  "v3:1111111111111111111111111111111111111111111111111111111111111111",
              },
              {
                source: "synthetic-bank",
                externalId:
                  "v3:2222222222222222222222222222222222222222222222222222222222222222",
              },
            ],
          ],
        ]),
      );
      const corrected = await lineage();
      expect(
        await reconcileFinancialEvidenceCorrection(ctx.db, input, ctx.actor),
      ).toEqual({ status: "unchanged", reason: "already_current" });
      expect(await lineage()).toEqual(corrected);
    },
  );

  // Direct correction probes cannot establish the real intake's
  // corroboration and completed-window proof, including empty windows.
  it("corrects and retires through normalized intake with persisted source proof", async () => {
    const { input, money } = await fixture();
    const providerTransactionId = "synthetic-intake-correction";
    const providerAccountId = "synthetic-intake-account";
    await getDb(ctx.db)
      .update(sourceTransactionRecord)
      .set({ providerTransactionId, providerAccountId })
      .where(eq(sourceTransactionRecord.chargeKey, "synthetic-charge"));
    const coverage = {
      account: providerAccountId,
      from: "2026-09-01",
      to: "2026-09-30",
      visibility: "all",
    };
    const revision = recordSourceTransactionRecordsInput.parse({
      import: {
        source: input.source,
        label: "Synthetic source revision",
        fingerprint: "synthetic-real-source-revision",
        observedAt: "2026-11-01T00:00:00Z",
        rowCountDeclared: 1,
        coverage,
      },
      rows: [
        {
          providerTransactionId,
          providerAccountId,
          accountDescriptor: "Synthetic cash",
          statementDate: "2026-09-01",
          providerAmount: -40,
          rawDescription: "Synthetic store",
          providerStatus: null,
        },
      ],
      complete: true,
    });
    expect(
      await recordSourceTransactionRecords(ctx.db, revision, ctx.actor),
    ).toMatchObject({ inserted: 1, revised: 1, correctionReviews: [] });
    expect(await money()).toEqual({
      amount: 40,
      status: "observed",
      allocations: [40],
      expenses: [40],
    });
    const withdrawal = recordSourceTransactionRecordsInput.parse({
      import: {
        ...revision.import,
        label: "Synthetic source withdrawal",
        fingerprint: "synthetic-real-source-withdrawal",
        observedAt: "2026-11-02T00:00:00Z",
        rowCountDeclared: 0,
      },
      rows: [],
      complete: true,
      confirmedWithdrawals: [providerTransactionId],
    });
    expect(
      await recordSourceTransactionRecords(ctx.db, withdrawal, ctx.actor),
    ).toMatchObject({ withdrawn: 1, correctionReviews: [] });
    expect(await money()).toEqual({
      amount: 40,
      status: "void",
      allocations: [],
      expenses: [],
    });
    expect(
      await recordSourceTransactionRecords(ctx.db, withdrawal, ctx.actor),
    ).toMatchObject({ withdrawn: 0, revised: 0 });
    expect(await money()).toEqual({
      amount: 40,
      status: "void",
      allocations: [],
      expenses: [],
    });
  });

  it.each(["independent", "superseded", "unresolved"])(
    "respects a %s historical predecessor during provider revision and withdrawal",
    async (predecessorState) => {
      const { input, money } = await fixture(
        false,
        predecessorState === "unresolved"
          ? {
              source: "synthetic-other",
              externalId: "synthetic-unresolved-reference",
            }
          : undefined,
      );
      const history = await getDb(ctx.db)
        .select()
        .from(sourceTransactionRecord);
      const predecessor = history.find((row) => !row.current);
      const head = history.find((row) => row.current);
      if (!predecessor || !head)
        throw new Error("Synthetic correction history missing");
      // Reproduce a retained older charge and its proven provider-history bridge.
      await getDb(ctx.db)
        .update(sourceTransactionRecord)
        .set({
          chargeKey: "synthetic-predecessor-charge",
          current: true,
          supersededByRowId:
            predecessorState !== "independent" ? head.id : null,
        })
        .where(eq(sourceTransactionRecord.id, predecessor.id));
      await getDb(ctx.db)
        .update(sourceTransactionRecord)
        .set({
          providerTransactionId: "synthetic-reconciled-provider",
          providerAccountId: "synthetic-reconciled-account",
          legacyReference: predecessor.externalId,
        })
        .where(eq(sourceTransactionRecord.id, head.id));
      const before = await money();
      const expectedReviewReasons =
        predecessorState === "superseded"
          ? []
          : [
              predecessorState === "unresolved"
                ? "Independent settlement evidence needs review before this booking changes."
                : "Other current source evidence still supports this booking or disagrees with the new amount.",
            ];
      const revision = recordSourceTransactionRecordsInput.parse({
        import: {
          source: input.source,
          label: "Synthetic reconciled revision",
          fingerprint: "synthetic-reconciled-revision",
          observedAt: "2026-11-01T00:00:00Z",
          rowCountDeclared: 1,
          coverage: {
            account: "synthetic-reconciled-account",
            from: "2026-09-01",
            to: "2026-09-30",
            visibility: "all",
          },
        },
        rows: [
          {
            providerTransactionId: "synthetic-reconciled-provider",
            providerAccountId: "synthetic-reconciled-account",
            accountDescriptor: "Synthetic cash",
            statementDate: "2026-09-01",
            providerAmount: -40,
            rawDescription: "Synthetic store",
          },
        ],
        complete: true,
      });
      const revised = await recordSourceTransactionRecords(
        ctx.db,
        revision,
        ctx.actor,
      );
      expect(revised).toMatchObject({ inserted: 1, revised: 1 });
      expect(revised.correctionReviews.map((review) => review.reason)).toEqual(
        expectedReviewReasons,
      );
      expect(await money()).toEqual(
        predecessorState === "superseded"
          ? {
              amount: 40,
              status: "observed",
              allocations: [40],
              expenses: [40],
            }
          : before,
      );
      const withdrawn = await recordSourceTransactionRecords(
        ctx.db,
        recordSourceTransactionRecordsInput.parse({
          import: {
            ...revision.import,
            fingerprint: "synthetic-reconciled-withdrawal",
            observedAt: "2026-11-02T00:00:00Z",
            rowCountDeclared: 0,
          },
          rows: [],
          complete: true,
          confirmedWithdrawals: ["synthetic-reconciled-provider"],
        }),
        ctx.actor,
      );
      expect(withdrawn).toMatchObject({ withdrawn: 1 });
      expect(
        withdrawn.correctionReviews.map((review) => review.reason),
      ).toEqual(expectedReviewReasons);
      expect(await money()).toEqual(
        predecessorState === "superseded"
          ? { amount: 40, status: "void", allocations: [], expenses: [] }
          : before,
      );
    },
  );

  // A later posted date can cross funding periods; the original accepted
  // attribution fingerprint cannot authorize money under the projected date.
  // Regression #3395: each agent session wrapped providerData differently, so
  // re-pulling an unchanged member-reviewed charge reopened a correction review.
  it("keeps an annotation-only re-observation of a reviewed booking unchanged", async () => {
    const { input, transaction, money } = await fixture();
    const providerTransactionId = "synthetic-annotation-replay";
    const providerAccountId = "synthetic-annotation-account";
    await getDb(ctx.db)
      .update(sourceTransactionRecord)
      .set({ providerTransactionId, providerAccountId })
      .where(eq(sourceTransactionRecord.chargeKey, "synthetic-charge"));
    // The current head is a later observation that agrees with the booking
    // but is not the reference the booking accepted.
    await getDb(ctx.db)
      .update(sourceTransactionRecord)
      .set({ providerAmount: -25, amount: 25 })
      .where(eq(sourceTransactionRecord.externalId, input.externalId));
    // A member-reviewed booking carries a plain, non-automatic fingerprint.
    await getDb(ctx.db)
      .update(financialTransaction)
      .set({ bookingDecisionFingerprint: "synthetic-member-review" })
      .where(eq(financialTransaction.id, transaction.entityId));
    const before = await money();
    const replay = recordSourceTransactionRecordsInput.parse({
      import: {
        source: input.source,
        label: "Synthetic annotation replay",
        fingerprint: "synthetic-annotation-replay",
        observedAt: "2026-11-01T00:00:00Z",
        rowCountDeclared: 1,
      },
      rows: [
        {
          providerTransactionId,
          providerAccountId,
          providerData: { transaction: { id: providerTransactionId } },
          accountDescriptor: "Synthetic cash",
          statementDate: "2026-09-01",
          providerAmount: -25,
          rawDescription: "Synthetic store",
          providerStatus: null,
        },
      ],
    });
    expect(
      await recordSourceTransactionRecords(ctx.db, replay, ctx.actor),
    ).toMatchObject({
      inserted: 0,
      unchanged: 1,
      revised: 0,
      correctionReviews: [],
    });
    expect(await money()).toEqual(before);
  });

  it("still reviews a null-status date move on a reviewed booking", async () => {
    const { input, transaction, money } = await fixture();
    await getDb(ctx.db)
      .update(sourceTransactionRecord)
      .set({ providerAmount: -25, amount: 25, statementDate: "2026-09-02" })
      .where(eq(sourceTransactionRecord.externalId, input.externalId));
    await getDb(ctx.db)
      .update(financialTransaction)
      .set({ bookingDecisionFingerprint: "synthetic-member-review" })
      .where(eq(financialTransaction.id, transaction.entityId));
    const before = await money();
    expect(
      await reconcileFinancialEvidenceCorrection(
        ctx.db,
        { ...input, amount: 25 },
        ctx.actor,
      ),
    ).toMatchObject({ status: "review" });
    expect(await money()).toEqual(before);
  });

  it("routes a changed effective funding date to review without rewriting its booking", async () => {
    const { input, money } = await fixture(true);
    await getDb(ctx.db)
      .update(sourceTransactionRecord)
      .set({ providerStatus: "posted", statementDate: "2026-09-02" })
      .where(eq(sourceTransactionRecord.externalId, input.externalId));
    const before = await money();
    expect(
      await reconcileFinancialEvidenceCorrection(ctx.db, input, ctx.actor),
    ).toEqual({
      status: "review",
      reason:
        "The source date changed the booking's funding date. Review its dated allocations and Expenses individually.",
    });
    expect(await money()).toEqual(before);
  });

  it("refuses mismatched evidence and edited generated Expenses without changing money", async () => {
    const { input, line, money } = await fixture();
    expect(
      await reconcileFinancialEvidenceCorrection(
        ctx.db,
        { ...input, amount: 31 },
        ctx.actor,
      ),
    ).toMatchObject({
      status: "review",
      reason: expect.stringContaining("disagrees"),
    });
    await updateExpense(
      ctx.db,
      line.output.id,
      { notes: "Synthetic member decision" },
      ctx.actor,
    );
    expect(
      await reconcileFinancialEvidenceCorrection(ctx.db, input, ctx.actor),
    ).toMatchObject({
      status: "review",
      reason: expect.stringContaining("lineage changed"),
    });
    expect(await money()).toEqual({
      amount: 25,
      status: "observed",
      allocations: [25],
      expenses: [25],
    });
  });

  it("leaves generated money unchanged while automatic spending is paused", async () => {
    const { input, money } = await fixture();
    const before = await money();
    await setAutomaticRule(ctx.db, ctx.actor, {
      ruleKey: "statement_transaction.book_spending",
      enabled: false,
    });
    expect(
      await reconcileFinancialEvidenceCorrection(ctx.db, input, ctx.actor),
    ).toMatchObject({
      status: "review",
      reason: expect.stringContaining("is off"),
    });
    expect(await money()).toEqual(before);
    await setAutomaticRule(ctx.db, ctx.actor, {
      ruleKey: "statement_transaction.book_spending",
      enabled: true,
    });
    expect(
      await reconcileFinancialEvidenceCorrection(ctx.db, input, ctx.actor),
    ).toMatchObject({ status: "corrected" });
    expect((await money()).expenses).toEqual([30]);
  });

  it("requires persisted withdrawal and caller proof, then retains retired booking history on replay", async () => {
    const { input, transaction, line, money } = await fixture();
    const withdrawal = { ...input, amount: null };
    expect(
      await reconcileFinancialEvidenceCorrection(ctx.db, withdrawal, ctx.actor),
    ).toMatchObject({ status: "review" });
    await getDb(ctx.db)
      .update(sourceTransactionRecord)
      .set({ current: false, withdrawnAt: new Date() })
      .where(
        and(
          eq(sourceTransactionRecord.source, input.source),
          eq(sourceTransactionRecord.externalId, input.externalId),
          notDeleted(sourceTransactionRecord),
        ),
      );
    expect(
      await reconcileFinancialEvidenceCorrection(
        ctx.db,
        {
          ...withdrawal,
          verifyCurrentEvidence: () =>
            Promise.resolve({
              status: "review",
              reason: "Another current source corroborates this charge.",
            }),
        },
        ctx.actor,
      ),
    ).toEqual({
      status: "review",
      reason: "Another current source corroborates this charge.",
    });
    expect(await money()).toEqual({
      amount: 25,
      status: "observed",
      allocations: [25],
      expenses: [25],
    });
    expect(
      await reconcileFinancialEvidenceCorrection(ctx.db, withdrawal, ctx.actor),
    ).toEqual({ status: "corrected", reason: "source_withdrawn" });
    expect(await money()).toEqual({
      amount: 25,
      status: "void",
      allocations: [],
      expenses: [],
    });
    const retired = await getDb(ctx.db).query.expense.findFirst({
      where: eq(expense.id, line.entityId),
    });
    expect(retired).toMatchObject({
      cost: 25,
      bookingTransactionCode: transaction.output.id,
      deletedAt: expect.any(Date),
    });
    expect(
      await reconcileFinancialEvidenceCorrection(ctx.db, withdrawal, ctx.actor),
    ).toEqual({ status: "unchanged", reason: "already_withdrawn" });
  });
});
