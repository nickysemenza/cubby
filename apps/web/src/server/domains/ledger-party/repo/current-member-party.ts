import type {
  LedgerPartyId,
  LedgerPartyShortcode,
  UserId,
} from "@cubby/schemas/identifiers";
import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import { and, eq } from "drizzle-orm";

import { type Database } from "~/server/db/database";
import { notDeleted } from "~/server/db/helpers/predicates";
import { type RepositoryQueryTransaction as DrizzleTransaction } from "~/server/db/repository-access.boundary";
import { repositoryQueries as unwrapDb } from "~/server/db/repository-access.boundary";
import { ledgerParty } from "~/server/db/retained-tables";

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
