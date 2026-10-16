import { financialAccountIdentityKind } from "@cubby/schemas/financial-account-fields";
import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import { and, asc, eq, sql } from "drizzle-orm";

import type { Database } from "~/server/db";
import { getDb, notDeleted } from "~/server/db/helpers";
import { financialAccount, ledgerParty } from "~/server/db/schema";

export async function cardholderSuggestionMembers(db: Database) {
  const rows = await getDb(db)
    .select({ id: ledgerParty.shortcode, name: ledgerParty.name })
    .from(ledgerParty)
    .where(and(notDeleted(ledgerParty), eq(ledgerParty.kind, "member")))
    .orderBy(asc(ledgerParty.name), asc(ledgerParty.shortcode));
  return rows.map((row) => ({
    ...row,
    id: parseShortcodeFor("ledgerParty", row.id),
  }));
}

export async function savedCardIssuers(db: Database): Promise<string[]> {
  const issuer = sql<string>`${financialAccount.identity}->>${"issuer"}`;
  const rows = await getDb(db)
    .selectDistinct({ issuer })
    .from(financialAccount)
    .where(
      and(
        notDeleted(financialAccount),
        sql`${financialAccount.identity}->>${"kind"} = ${financialAccountIdentityKind.enum.credit_card}`,
        sql`${issuer} IS NOT NULL`,
      ),
    );
  return rows.map((row) => row.issuer).sort((a, b) => a.localeCompare(b));
}
