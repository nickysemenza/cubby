import { recordSourceTransactionRecordsInput } from "@cubby/schemas/source-transaction-record";
import { minorToMoney } from "@cubby/shared";
import { and, eq } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import { createRepoEntity } from "tooling/factories/repo";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { getDb, notDeleted } from "~/server/db/helpers";
import { relationalSql } from "~/server/db/helpers/relational-sql";
import {
  expense,
  financialTransaction,
  financialTransactionAllocation,
  sourceTransactionRecord,
  sourceOccurrence,
} from "~/server/db/schema";
import { updateExpense } from "~/server/domains/expense/repo/crud";
import { financialSourceRefsFor } from "~/server/domains/financial-transaction/repo/financial-source-evidence";
import { updateSourceTransactionRecords } from "~/server/domains/transaction-import/repo/source-transaction-record";
import { recordSourceTransactionRecords } from "~/server/domains/transaction-import/repo/source-transaction-record";
import { listSourceTransactionRecords } from "~/server/domains/transaction-import/repo/source-transaction-record.fixtures";

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
    headAmount = 30,
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
      sourceRefs: extraReference ? [extraReference] : [],
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
    for (const [index, amount] of (headAmount === 25
      ? [25]
      : [25, headAmount]
    ).entries())
      await recordSourceTransactionRecords(
        ctx.db,
        recordSourceTransactionRecordsInput.parse({
          import: {
            source: "monarch",
            label: "Synthetic observations",
            fingerprint: `synthetic-correction-${index}`,
            observedAt: `2026-10-0${index + 1}T00:00:00Z`,
          },
          rows: [
            {
              providerTransactionId: "synthetic-correction-event",
              providerAccountId: "synthetic-correction-account",
              providerData: {
                id: "synthetic-correction-event",
                account_id: "synthetic-correction-account",
              },
              rowPosition: 1,
              accountDescriptor: "Synthetic cash",
              statementDate: "2026-09-01",
              rawDescription: "Synthetic store",
              providerAmount: -amount,
            },
          ],
        }),
        ctx.actor,
      );
    const history = await getDb(ctx.db).select().from(sourceTransactionRecord);
    const head = history.find((row) => row.amount === BigInt(headAmount * 100));
    if (!head?.occurrenceId) throw new Error("Synthetic occurrence missing");
    // Domain correction fixture starts after a reviewed source frontier advanced.
    // It names acceptance directly; aliases cannot establish this relationship.
    await getDb(ctx.db)
      .update(sourceOccurrence)
      .set({
        accountId: account.entityId,
        currentObservationId: head.id,
        acceptedTransactionId: transaction.entityId,
        reviewState: "ready",
      })
      .where(eq(sourceOccurrence.id, head.occurrenceId));
    const [occurrence] = await getDb(ctx.db)
      .select()
      .from(sourceOccurrence)
      .where(eq(sourceOccurrence.id, head.occurrenceId));
    if (!occurrence) throw new Error("Synthetic occurrence missing");
    // Source acceptance is part of the frozen booking facts.
    await getDb(ctx.db)
      .update(financialTransaction)
      .set({
        bookingDecisionFingerprint: `automatic:${await acceptedAutomaticFacts(ctx.db, transaction.output.id)}`,
      })
      .where(eq(financialTransaction.id, transaction.entityId));
    const input: FinancialEvidenceCorrectionInput = {
      source: "monarch",
      externalId: occurrence.shortcode,
      transactionId: transaction.output.id,
      amount: headAmount,
      verifyCurrentEvidence: verify,
    };
    const lineage = () =>
      loadFinancialBookingLineage(ctx.db, transaction.output.id);
    const money = async () => {
      const stored = await getDb(ctx.db).query.financialTransaction.findFirst({
        where: {
          RAW: (table: PgTable) =>
            relationalSql(
              table,
              eq(financialTransaction.id, transaction.entityId),
            ),
        },
        with: { allocations: true },
      });
      return {
        amount: stored ? minorToMoney(stored.amount) : undefined,
        status: stored?.status,
        allocations: stored?.allocations
          .filter((row) => row.deletedAt === null)
          .map((row) => minorToMoney(row.amountMinor)),
        expenses: (await lineage()).lines.map((row) => row.cost),
      };
    };
    return { input, transaction, line, lineage, money, head, occurrence };
  }

  it.each([true])(
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
            where: {
              RAW: (table: PgTable) =>
                relationalSql(
                  table,
                  and(
                    eq(
                      financialTransactionAllocation.transactionId,
                      transaction.entityId,
                    ),
                    notDeleted(financialTransactionAllocation),
                  ),
                ),
            },
            columns: { confirmsMerchant: true },
          })
        ).map((row) => row.confirmsMerchant),
      ).toEqual([confirmsMerchant]);
      expect(
        await financialSourceRefsFor(ctx.db, [transaction.entityId]),
      ).toEqual(
        new Map([
          [
            transaction.entityId,
            [{ source: input.source, externalId: input.externalId }],
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
    const { input, money, head } = await fixture();
    const providerTransactionId = "synthetic-correction-event";
    const providerAccountId = "synthetic-correction-account";
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
          providerData: {
            id: providerTransactionId,
            account_id: providerAccountId,
          },
          rowPosition: 1,
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
    expect((await money()).amount).toBe(25);
    const observations = (await listSourceTransactionRecords(ctx.db, {})).data;
    const previous = observations.find(
      (observation) => observation.id === head.shortcode,
    );
    const next = observations.find(
      (observation) =>
        observation.importFingerprint === revision.import.fingerprint,
    );
    if (!previous || !next)
      throw new Error("Synthetic reviewed source revision missing");
    await updateSourceTransactionRecords(
      ctx.db,
      {
        selector: { source: input.source, externalIds: [previous.externalId] },
        data: { supersededByExternalId: next.externalId },
      },
      ctx.actor,
    );
    await recordSourceTransactionRecords(ctx.db, revision, ctx.actor);
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

  // A later posted date can cross funding periods; the original accepted
  // attribution fingerprint cannot authorize money under the projected date.
  // Regression #3395: each agent session wrapped providerData differently, so
  // re-pulling an unchanged member-reviewed charge reopened a correction review.
  it("keeps an annotation-only re-observation of a reviewed booking unchanged", async () => {
    const { input, transaction, money } = await fixture(
      false,
      undefined,
      true,
      25,
    );
    const providerTransactionId = "synthetic-correction-event";
    const providerAccountId = "synthetic-correction-account";
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
          providerData: {
            transaction: {
              id: providerTransactionId,
              account_id: providerAccountId,
            },
            account: { id: providerAccountId },
          },
          rowPosition: 1,
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
    const { input, transaction, money, head } = await fixture(
      false,
      undefined,
      true,
      25,
    );
    await getDb(ctx.db)
      .update(sourceTransactionRecord)
      .set({ statementDate: "2026-09-02" })
      .where(eq(sourceTransactionRecord.id, head.id));
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
    const { input, money, head } = await fixture(true);
    await getDb(ctx.db)
      .update(sourceTransactionRecord)
      .set({ providerStatus: "posted", statementDate: "2026-09-02" })
      .where(eq(sourceTransactionRecord.id, head.id));
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

  it("requires persisted withdrawal and caller proof, then retains retired booking history on replay", async () => {
    const { input, transaction, line, money, occurrence } = await fixture();
    const withdrawal = { ...input, amount: null };
    expect(
      await reconcileFinancialEvidenceCorrection(ctx.db, withdrawal, ctx.actor),
    ).toMatchObject({ status: "review" });
    await getDb(ctx.db)
      .update(sourceOccurrence)
      .set({ withdrawnAt: new Date() })
      .where(eq(sourceOccurrence.id, occurrence.id));
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
      where: {
        RAW: (table: PgTable) =>
          relationalSql(table, eq(expense.id, line.entityId)),
      },
    });
    expect(retired).toMatchObject({
      cost: 2500n,
      bookingTransactionCode: transaction.output.id,
      deletedAt: expect.any(Date),
    });
    expect(
      await reconcileFinancialEvidenceCorrection(ctx.db, withdrawal, ctx.actor),
    ).toEqual({ status: "unchanged", reason: "already_withdrawn" });
  });
});
