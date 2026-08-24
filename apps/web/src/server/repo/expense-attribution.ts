import type { ExpenseId } from "@cubby/schemas/identifiers";
import type { LedgerAttributionInput } from "@cubby/schemas/ledger-party";
import { and, eq } from "drizzle-orm";
import type { DrizzleTransaction } from "~/server/db";
import { expenseAttribution } from "~/server/db/schema";
import { notDeleted } from "~/server/repo/database-helpers";
import { lockLedgerPartiesForReference } from "~/server/repo/ledger-party-reference";

export async function replaceExpenseAttributionRole(
  tx: DrizzleTransaction,
  expenseId: ExpenseId,
  role: "beneficiary" | "funder",
  values: readonly LedgerAttributionInput[],
) {
  const referenced = values.filter(
    (
      value,
    ): value is LedgerAttributionInput & { partyId: NonNullable<string> } =>
      value.partyId !== null,
  );
  const parties = await lockLedgerPartiesForReference(
    tx,
    referenced.map((value) => value.partyId),
  );
  let partyIndex = 0;
  const resolved = values.map((value) => ({
    ledgerPartyId: value.partyId ? parties[partyIndex++]!.id : null,
    weight: value.weight,
  }));
  await tx
    .update(expenseAttribution)
    .set({ deletedAt: new Date() })
    .where(
      and(
        eq(expenseAttribution.expenseId, expenseId),
        eq(expenseAttribution.role, role),
        notDeleted(expenseAttribution),
      ),
    );
  if (resolved.length)
    await tx
      .insert(expenseAttribution)
      .values(resolved.map((row) => ({ expenseId, role, ...row })));
}
