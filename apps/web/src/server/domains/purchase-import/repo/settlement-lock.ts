import type { LedgerPartyId } from "@cubby/schemas/identifiers";

import type { DrizzleTransaction } from "~/server/db";
import { advisoryXactLock } from "~/server/db/advisory-lock";
import { enterWriteTransaction } from "~/server/kernel/gate";

/** Serialize source acceptance and settlement for one member, after the household gate. */
export async function lockPartySettlement(
  tx: Pick<DrizzleTransaction, "execute">,
  ledgerPartyId: LedgerPartyId,
): Promise<void> {
  await enterWriteTransaction(tx, { lane: "money", mode: "member" });
  await advisoryXactLock(tx, "purchase-settlement", ledgerPartyId);
}
