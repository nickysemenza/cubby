import { systemActor, type ActorContext } from "@cubby/schemas/context";
import type { ExpenseId } from "@cubby/schemas/identifiers";
import type { LedgerAttributionInput } from "@cubby/schemas/ledger-party";
import { and, eq, inArray } from "drizzle-orm";

import type { Database, DrizzleTransaction } from "~/server/db";
import { notDeleted, unwrapDb } from "~/server/db/helpers";
import { expenseAttribution, ledgerParty } from "~/server/db/schema";
import { rejectPurchaseEventWhere } from "~/server/domains/financial-transaction/repo/purchase-event-mutations";
import { insertPurchaseEventRows } from "~/server/domains/financial-transaction/repo/purchase-event-mutations";
import { lockLedgerPartiesForReference } from "~/server/domains/ledger-party/repo/ledger-party-reference";
import { createAppError } from "~/server/errors/app-error";

/** The review freezes live party semantics; the writer acquires reference locks at commit. */
export async function readExpenseAttributionParties(
  db: Database,
  values: readonly LedgerAttributionInput[] | undefined,
) {
  const codes =
    values?.flatMap((share) => (share.partyId ? [share.partyId] : [])) ?? [];
  const rows = codes.length
    ? await unwrapDb(db)
        .select({
          shortcode: ledgerParty.shortcode,
          name: ledgerParty.name,
          kind: ledgerParty.kind,
        })
        .from(ledgerParty)
        .where(
          and(inArray(ledgerParty.shortcode, codes), notDeleted(ledgerParty)),
        )
        .orderBy(ledgerParty.id)
    : [];
  if (rows.length !== codes.length)
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      "A reviewed beneficiary is no longer live.",
    );
  return rows;
}

export async function replaceExpenseAttributionRole(
  tx: DrizzleTransaction,
  expenseId: ExpenseId,
  role: "beneficiary" | "funder",
  values: readonly LedgerAttributionInput[],
  actor: ActorContext = systemActor(),
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
  await rejectPurchaseEventWhere(
    tx,
    "ExpenseAttribution",
    and(
      eq(expenseAttribution.expenseId, expenseId),
      eq(expenseAttribution.role, role),
      notDeleted(expenseAttribution),
    ),
    actor,
  );
  if (resolved.length)
    await insertPurchaseEventRows(
      tx,
      "ExpenseAttribution",
      resolved.map((row) => ({ expenseId, role, ...row })),
      actor,
    );
}
