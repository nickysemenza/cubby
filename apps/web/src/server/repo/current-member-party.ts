import type {
  LedgerPartyId,
  LedgerPartyShortcode,
  UserId,
} from "@cubby/schemas/identifiers";
import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import { and, eq } from "drizzle-orm";

import type { Database, DrizzleTransaction } from "~/server/db";
import { ledgerParty } from "~/server/db/schema";

import { unwrapDb } from "./database-helpers/core";
import { notDeleted } from "./database-helpers/query";

export type CurrentParty = {
  id: LedgerPartyId;
  shortcode: LedgerPartyShortcode;
  name: string;
};

/** The live `member` ledger party the acting login is linked to, if any. */
export async function currentMemberLedgerParty(
  db: Database | DrizzleTransaction,
  actor: { userId: UserId },
): Promise<CurrentParty | null> {
  const [party] = await unwrapDb(db)
    .select({
      id: ledgerParty.id,
      shortcode: ledgerParty.shortcode,
      name: ledgerParty.name,
    })
    .from(ledgerParty)
    .where(
      and(
        eq(ledgerParty.userId, actor.userId),
        eq(ledgerParty.kind, "member"),
        notDeleted(ledgerParty),
      ),
    )
    .limit(1);
  return party
    ? { ...party, shortcode: parseShortcodeFor("ledgerParty", party.shortcode) }
    : null;
}
