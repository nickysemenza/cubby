import type { ActorContext } from "@cubby/schemas/context";
import {
  acceptFinancialTransferPairOut,
  type AcceptFinancialTransferPairInput,
  type AcceptFinancialTransferPairOut,
} from "@cubby/schemas/household-contribution";
import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import { cents } from "@cubby/shared";
import { and, eq, inArray, sql } from "drizzle-orm";

import type { Database } from "~/server/db";
import {
  databaseForTransaction,
  notDeleted,
  withSnapshotWrite,
} from "~/server/db/helpers";
import {
  financialAccount,
  financialTransaction,
  ledgerParty,
} from "~/server/db/schema";
import {
  createLedgerTransfer,
  transferEvidenceLegFields,
  transferEvidenceLegProblem,
} from "~/server/domains/ledger-transfer/repo";

const refuse = (reason: string): AcceptFinancialTransferPairOut => ({
  canProceed: false,
  reason,
});

/**
 * Accept one suggested transfer pair: create the Ledger Transfer from the
 * outflow account's owner to the inflow account's owner and link both legs as
 * its evidence, in one transaction. Every precondition the household can fix
 * is refused as data naming the record; nothing persists on a refusal. A
 * same-owner pair is an internal move (`fromPartyId = toPartyId`).
 */
export async function acceptFinancialTransferPair(
  db: Database,
  input: AcceptFinancialTransferPairInput,
  actor: ActorContext,
): Promise<AcceptFinancialTransferPairOut> {
  const result = await withSnapshotWrite(
    db,
    async (tx) => {
      const codes = [input.outflowTransactionId, input.inflowTransactionId];
      if (codes[0] === codes[1])
        return refuse(
          `${codes[0]} was given as both legs; a transfer pair needs two transactions.`,
        );
      const rows = await tx
        .select({
          shortcode: financialTransaction.shortcode,
          amount: financialTransaction.amount,
          date: sql<
            string | null
          >`COALESCE(${financialTransaction.postedDate}, ${financialTransaction.transactionDate})`,
          ledgerTransferId: financialTransaction.ledgerTransferId,
          accountId: financialTransaction.accountId,
          accountName: financialAccount.name,
          ...transferEvidenceLegFields,
          partyShortcode: ledgerParty.shortcode,
        })
        .from(financialTransaction)
        .innerJoin(
          financialAccount,
          eq(financialTransaction.accountId, financialAccount.id),
        )
        .leftJoin(
          ledgerParty,
          and(
            eq(financialAccount.ledgerPartyId, ledgerParty.id),
            notDeleted(ledgerParty),
          ),
        )
        .where(
          and(
            inArray(financialTransaction.shortcode, codes),
            notDeleted(financialTransaction),
          ),
        )
        .for("update", { of: financialTransaction });
      const byCode = new Map(
        rows.map((row) => [
          row.shortcode,
          { ...row, amount: Number(row.amount) },
        ]),
      );
      const outflow = byCode.get(input.outflowTransactionId);
      const inflow = byCode.get(input.inflowTransactionId);
      if (!outflow)
        return refuse(
          `${input.outflowTransactionId} is not a live financial transaction.`,
        );
      if (!inflow)
        return refuse(
          `${input.inflowTransactionId} is not a live financial transaction.`,
        );
      // Positive amounts leave an account; negative amounts arrive.
      if (!(outflow.amount > 0 && inflow.amount < 0))
        return refuse(
          `Opposite signs required: outflow ${outflow.shortcode} is ${outflow.amount} and inflow ${inflow.shortcode} is ${inflow.amount}; the outflow must be positive and the inflow negative.`,
        );
      if (cents(outflow.amount) !== -cents(inflow.amount))
        return refuse(
          `Amounts differ: ${outflow.shortcode} is ${outflow.amount} and ${inflow.shortcode} is ${inflow.amount}.`,
        );
      if (outflow.accountId === inflow.accountId)
        return refuse(
          `${outflow.shortcode} and ${inflow.shortcode} are both on account ${outflow.accountShortcode}; a transfer pair spans two accounts.`,
        );
      // The same evidence rules createLedgerTransfer enforces, rechecked under
      // the row lock so a fixable leg is refused as data instead of thrown.
      for (const leg of [outflow, inflow]) {
        const problem = transferEvidenceLegProblem(leg);
        if (problem) return refuse(`${leg.shortcode} ${problem}.`);
      }
      for (const leg of [outflow, inflow])
        if (!leg.partyShortcode)
          return refuse(
            `Account ${leg.accountShortcode} (${leg.accountName}) has no owner; set its owner before accepting ${leg.shortcode}.`,
          );
      for (const leg of [outflow, inflow])
        if (leg.ledgerTransferId)
          return refuse(
            `${leg.shortcode} already evidences a ledger transfer.`,
          );
      if (!outflow.date || !inflow.date)
        return refuse(
          `${(outflow.date ? inflow : outflow).shortcode} has no posted or transaction date.`,
        );

      const date = outflow.date < inflow.date ? outflow.date : inflow.date;
      const fromPartyId = parseShortcodeFor(
        "ledgerParty",
        outflow.partyShortcode!,
      );
      const toPartyId = parseShortcodeFor(
        "ledgerParty",
        inflow.partyShortcode!,
      );
      const amount = Math.abs(outflow.amount);
      const { output } = await createLedgerTransfer(
        databaseForTransaction(tx),
        {
          fromPartyId,
          toPartyId,
          amount,
          date,
          notes: null,
          sourceClaims: [],
          evidenceTransactionIds: [
            input.outflowTransactionId,
            input.inflowTransactionId,
          ],
        },
        actor,
      );
      if (!output)
        throw new Error(
          "Created ledger transfer was not readable in its transaction",
        );
      return {
        canProceed: true,
        transferId: output.id,
        fromPartyId,
        toPartyId,
        amount,
        date,
        internalMove: fromPartyId === toPartyId,
      } satisfies AcceptFinancialTransferPairOut;
    },
    { isolationLevel: "serializable" },
  );
  return acceptFinancialTransferPairOut.parse(result);
}
