import { and, eq } from "drizzle-orm";
import { createRepoEntity } from "tooling/factories/repo";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { getDb, notDeleted } from "~/server/db/helpers";
import {
  expense,
  financialTransaction,
  statementImport,
  statementRow,
} from "~/server/db/schema";
import { updateExpense } from "~/server/domains/expense/repo/crud";
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

  async function fixture() {
    const owner = await createRepoEntity(ctx, "ledgerParty", {
      kind: "member",
      name: "Synthetic correction member",
    });
    const account = await createRepoEntity(ctx, "financialAccount", {
      name: "Synthetic correction account",
      identity: { kind: "cash" },
      ledgerPartyId: owner.output.id,
      provisional: false,
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
      status: "observed",
      amount: 25,
      transactionDate: "2026-09-01",
      sourceRefs: [
        {
          source: "synthetic-bank",
          externalId:
            "v3:1111111111111111111111111111111111111111111111111111111111111111",
        },
      ],
      allocations: [{ purchaseId: purchase.output.id, amount: 25 }],
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
    const [batch] = await getDb(ctx.db)
      .insert(statementImport)
      .values({
        source: "synthetic-bank",
        label: "Synthetic observations",
        fingerprint: "synthetic-correction",
      })
      .returning();
    if (!batch) throw new Error("Synthetic import was not created");
    await getDb(ctx.db)
      .insert(statementRow)
      .values([
        {
          batchId: batch.id,
          source: "synthetic-bank",
          externalId:
            "v3:1111111111111111111111111111111111111111111111111111111111111111",
          chargeKey: "synthetic-charge",
          current: false,
          accountId: account.entityId,
          accountDescriptor: "Synthetic cash",
          statementDate: "2026-09-01",
          rawDescription: "Synthetic store",
          amount: 25,
          providerAmount: 25,
        },
        {
          batchId: batch.id,
          source: "synthetic-bank",
          externalId:
            "v3:2222222222222222222222222222222222222222222222222222222222222222",
          chargeKey: "synthetic-charge",
          current: true,
          accountId: account.entityId,
          accountDescriptor: "Synthetic cash",
          statementDate: "2026-09-01",
          rawDescription: "Synthetic store",
          amount: 30,
          providerAmount: 30,
        },
      ]);
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

  it("corrects a new observation of the accepted charge once without changing member shares", async () => {
    const { input, transaction, lineage, money } = await fixture();
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
      .update(statementRow)
      .set({ current: false, withdrawnAt: new Date() })
      .where(
        and(
          eq(statementRow.source, input.source),
          eq(statementRow.externalId, input.externalId),
          notDeleted(statementRow),
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
