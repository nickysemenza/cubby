import { and, eq, sql } from "drizzle-orm";

import type { Database, DrizzleTransaction } from "~/server/db";
import { notDeleted, unwrapDb, uuidArrayParam } from "~/server/db/helpers";
import {
  financialTransaction,
  ledgerTransfer,
} from "~/server/db/retained-tables";
import { entityDisplayImagePresenceSql } from "~/server/entity-kernel/repo/entity-display-image";
import { qualityCheck } from "~/server/generic/data-quality/repo/builders";
import { defineStoredEntityChecks } from "~/server/generic/data-quality/repo/stored-registry";

/** Bump when the rules or their declared scoring metadata change. */
const LEDGER_TRANSFER_QUALITY_RULES_VERSION = 1;

type LedgerTransferQualityRecord = Awaited<
  ReturnType<typeof loadLedgerTransferQualityRecords>
>[number];

export const ledgerTransferChecks = defineStoredEntityChecks({
  entity: "ledgerTransfer",
  table: ledgerTransfer,
  rulesVersion: LEDGER_TRANSFER_QUALITY_RULES_VERSION,
  load: loadLedgerTransferQualityRecords,
  checks: {
    ledgertransfer_display_image: qualityCheck.hasImage,
    ledger_transfer_transaction: qualityCheck.hasRelated(
      (record: LedgerTransferQualityRecord) => record.transactions,
    ),
  },
});

async function loadLedgerTransferQualityRecords(
  db: Database | DrizzleTransaction,
  ids: readonly string[],
) {
  if (!ids.length) return [];
  return unwrapDb(db)
    .select({
      id: ledgerTransfer.id,
      shortcode: ledgerTransfer.shortcode,
      transactions: sql<string[]>`coalesce(
        array_agg(${financialTransaction.id}) FILTER (WHERE ${financialTransaction.id} IS NOT NULL),
        ARRAY[]::uuid[]
      )`,
      hasDisplayImage: sql<boolean>`bool_or(${entityDisplayImagePresenceSql("ledgerTransfer", sql`${ledgerTransfer.id}`)})`,
    })
    .from(ledgerTransfer)
    .leftJoin(
      financialTransaction,
      and(
        eq(financialTransaction.ledgerTransferId, ledgerTransfer.id),
        notDeleted(financialTransaction),
        sql`${financialTransaction.status} <> 'void'`,
      ),
    )
    .where(
      and(
        notDeleted(ledgerTransfer),
        sql`${ledgerTransfer.id} = ANY(${uuidArrayParam(ids)})`,
      ),
    )
    .groupBy(ledgerTransfer.id, ledgerTransfer.shortcode);
}
