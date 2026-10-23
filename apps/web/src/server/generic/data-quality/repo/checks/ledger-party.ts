import { and, eq, sql } from "drizzle-orm";

import type { Database, DrizzleTransaction } from "~/server/db";
import { notDeleted, unwrapDb, uuidArrayParam } from "~/server/db/helpers";
import { financialAccount, ledgerParty } from "~/server/db/retained-tables";
import { entityDisplayImagePresenceSql } from "~/server/entity-kernel/repo/entity-display-image";
import { qualityCheck } from "~/server/generic/data-quality/repo/builders";
import { defineStoredEntityChecks } from "~/server/generic/data-quality/repo/stored-registry";

/** Bump when the rules or their declared scoring metadata change. */
export const LEDGER_PARTY_QUALITY_RULES_VERSION = 1;

type LedgerPartyQualityRecord = Awaited<
  ReturnType<typeof loadLedgerPartyQualityRecords>
>[number];

export const ledgerPartyChecks = defineStoredEntityChecks({
  entity: "ledgerParty",
  table: ledgerParty,
  rulesVersion: LEDGER_PARTY_QUALITY_RULES_VERSION,
  load: loadLedgerPartyQualityRecords,
  checks: {
    ledgerparty_display_image: qualityCheck.hasImage,
    // Only household members are expected to map at least one account.
    ledger_party_financial_account: qualityCheck.when(
      (record: LedgerPartyQualityRecord) => record.kind === "member",
      qualityCheck.hasRelated(
        (record: LedgerPartyQualityRecord) => record.financialAccounts,
      ),
    ),
  },
});

async function loadLedgerPartyQualityRecords(
  db: Database | DrizzleTransaction,
  ids: readonly string[],
) {
  if (!ids.length) return [];
  return unwrapDb(db)
    .select({
      id: ledgerParty.id,
      shortcode: ledgerParty.shortcode,
      kind: ledgerParty.kind,
      financialAccounts: sql<string[]>`coalesce(
        array_agg(${financialAccount.id}) FILTER (WHERE ${financialAccount.id} IS NOT NULL),
        ARRAY[]::uuid[]
      )`,
      hasDisplayImage: sql<boolean>`bool_or(${entityDisplayImagePresenceSql("ledgerParty", sql`${ledgerParty.id}`)})`,
    })
    .from(ledgerParty)
    .leftJoin(
      financialAccount,
      and(
        eq(financialAccount.ledgerPartyId, ledgerParty.id),
        notDeleted(financialAccount),
      ),
    )
    .where(
      and(
        notDeleted(ledgerParty),
        sql`${ledgerParty.id} = ANY(${uuidArrayParam(ids)})`,
      ),
    )
    .groupBy(ledgerParty.id, ledgerParty.shortcode, ledgerParty.kind);
}
