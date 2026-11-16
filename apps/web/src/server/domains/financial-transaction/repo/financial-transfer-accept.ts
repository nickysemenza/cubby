import type { ActorContext } from "@cubby/schemas/context";
import {
  acceptFinancialTransferPairOut,
  type AcceptFinancialTransferPairInput,
  type AcceptFinancialTransferPairOut,
} from "@cubby/schemas/household-contribution";
import { parseEntityId, parseShortcodeFor } from "@cubby/schemas/identifiers";
import { minorToMoney } from "@cubby/shared";
import { and, eq, inArray, sql } from "drizzle-orm";

import type { Database } from "~/server/db";
import { notDeleted } from "~/server/db/helpers";
import { recordKey } from "~/server/db/kernel-schema";
import { repositoryQueries } from "~/server/db/repository-access.boundary";
import {
  financialAccount,
  financialTransaction,
  ledgerParty,
  ledgerTransfer,
} from "~/server/db/schema";
import {
  transferEvidenceLegFields,
  transferEvidenceLegProblem,
} from "~/server/domains/ledger-transfer/repo/ledger-transfer";

const refuse = (reason: string): AcceptFinancialTransferPairOut => ({
  canProceed: false,
  reason,
});

/** A reviewed pair is a decision; transferPair alone publishes the movement and its legs. */
export async function acceptFinancialTransferPair(
  db: Database,
  input: AcceptFinancialTransferPairInput,
  actor: ActorContext,
): Promise<AcceptFinancialTransferPairOut> {
  const { householdWrite, decide, reconcileNow, recordSubject } =
    await import("~/server/kernel/api");
  return householdWrite(db, async (database) => {
    const codes = [input.outflowTransactionId, input.inflowTransactionId];
    if (codes[0] === codes[1])
      return refuse("A transfer pair needs two distinct transactions.");
    const rows = await repositoryQueries(database)
      .select({
        id: financialTransaction.id,
        shortcode: financialTransaction.shortcode,
        amount: financialTransaction.amount,
        kind: financialTransaction.kind,
        date: sql<
          string | null
        >`coalesce(${financialTransaction.transactionDate}, ${financialTransaction.postedDate})`,
        accountId: financialTransaction.accountId,
        ledgerTransferId: financialTransaction.ledgerTransferId,
        partyId: ledgerParty.shortcode,
        ...transferEvidenceLegFields,
      })
      .from(financialTransaction)
      .innerJoin(
        financialAccount,
        eq(financialAccount.id, financialTransaction.accountId),
      )
      .leftJoin(
        ledgerParty,
        and(
          eq(ledgerParty.id, financialAccount.ledgerPartyId),
          notDeleted(ledgerParty),
        ),
      )
      .where(
        and(
          inArray(financialTransaction.shortcode, codes),
          notDeleted(financialTransaction),
        ),
      );
    const outflow = rows.find((row) => row.shortcode === codes[0]);
    const inflow = rows.find((row) => row.shortcode === codes[1]);
    if (!outflow || !inflow)
      return refuse("Transfer evidence must name live financial transactions.");
    if (outflow.amount <= 0n || inflow.amount >= 0n)
      return refuse(
        "Opposite signs required: the outflow must be positive and the inflow negative.",
      );
    if (outflow.amount !== -inflow.amount)
      return refuse(
        "Amounts differ; transfer legs must be equal and opposite.",
      );
    if (outflow.accountId === inflow.accountId)
      return refuse(
        `Both legs are both on account ${outflow.accountShortcode}; a pair spans distinct accounts.`,
      );
    for (const leg of [outflow, inflow]) {
      const problem = transferEvidenceLegProblem(leg);
      if (problem) return refuse(`${leg.shortcode} ${problem}.`);
      if (!leg.partyId)
        return refuse(
          `Account ${leg.accountShortcode} has no owner; set its owner before accepting this pair.`,
        );
      if (leg.ledgerTransferId)
        return refuse(`${leg.shortcode} already evidences a ledger transfer.`);
      if (!leg.date)
        return refuse(`${leg.shortcode} has no posted or transaction date.`);
    }
    const scope = { kind: "transferPair", key: outflow.id };
    await decide(database, actor, [
      {
        channel: "identity",
        kind: "same",
        subject: `transferPair:${outflow.id}`,
        field: recordSubject("financialTransaction", inflow.id),
        scopes: [scope],
      },
      {
        channel: "assignment",
        kind: "set",
        subject: `transferPair:${outflow.id}`,
        field: "transactions",
        value: [outflow.id, inflow.id],
        scopes: [scope],
      },
    ]);
    const { updateBankTransactions } =
      await import("~/server/domains/financial-transaction/repo/bank-mutations");
    await updateBankTransactions(
      database,
      [outflow, inflow]
        .filter(
          (row) =>
            !["account_transfer", "credit_card_payment"].includes(row.kind),
        )
        .map((row) => ({ id: row.id, values: { kind: "account_transfer" } })),
      actor,
    );
    const [outcome] = await reconcileNow(database, [scope]);
    const [owner] = await repositoryQueries(database)
      .select()
      .from(recordKey)
      .where(
        and(
          eq(recordKey.entity, "ledgerTransfer"),
          eq(recordKey.scopeKind, scope.kind),
          eq(recordKey.scopeKey, scope.key),
        ),
      );
    if (!owner)
      return refuse(
        outcome?.gaps[0]?.input ??
          outcome?.error ??
          "Transfer evidence is unresolved.",
      );
    const [stored] = await repositoryQueries(database)
      .select()
      .from(ledgerTransfer)
      .where(
        eq(ledgerTransfer.id, parseEntityId("ledgerTransfer", owner.entityId)),
      );
    if (!stored)
      throw new Error("Transfer reconciler did not publish its record");
    return acceptFinancialTransferPairOut.parse({
      canProceed: true,
      transferId: stored.shortcode,
      fromPartyId: parseShortcodeFor("ledgerParty", outflow.partyId!),
      toPartyId: parseShortcodeFor("ledgerParty", inflow.partyId!),
      amount: minorToMoney(stored.amount),
      date: stored.date,
      internalMove: stored.fromPartyId === stored.toPartyId,
    });
  });
}
