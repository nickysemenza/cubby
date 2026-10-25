import { and, sql } from "drizzle-orm";

import type { Database, DrizzleTransaction } from "~/server/db";
import { notDeleted, unwrapDb, uuidArrayParam } from "~/server/db/helpers";
import { financialAccount } from "~/server/db/retained-tables";
import { entityDisplayImagePresenceSql } from "~/server/entity-kernel/repo/entity-display-image";
import { qualityCheck } from "~/server/generic/data-quality/repo/builders";
import { defineStoredEntityChecks } from "~/server/generic/data-quality/repo/stored-registry";

/** Bump when the rules or their declared scoring metadata change. */
const FINANCIAL_ACCOUNT_QUALITY_RULES_VERSION = 2;
type FinancialAccountQualityRecord = Awaited<
  ReturnType<typeof loadFinancialAccountQualityRecords>
>[number];
const observed = qualityCheck.observed<FinancialAccountQualityRecord>;

export const financialAccountChecks = defineStoredEntityChecks({
  entity: "financialAccount",
  table: financialAccount,
  rulesVersion: FINANCIAL_ACCOUNT_QUALITY_RULES_VERSION,
  load: loadFinancialAccountQualityRecords,
  checks: {
    financialaccount_display_image: qualityCheck.hasImage,
    financial_account_ledger_party: observed((r) => r.ledgerPartyId !== null),
  },
});

async function loadFinancialAccountQualityRecords(
  db: Database | DrizzleTransaction,
  ids: readonly string[],
) {
  if (!ids.length) return [];
  return unwrapDb(db)
    .select({
      id: financialAccount.id,
      shortcode: financialAccount.shortcode,
      hasDisplayImage: sql<boolean>`${entityDisplayImagePresenceSql("financialAccount", sql`${sql.identifier("FinancialAccount")}.${sql.identifier("id")}`)}`,
      ledgerPartyId: financialAccount.ledgerPartyId,
    })
    .from(financialAccount)
    .where(
      and(
        notDeleted(financialAccount),
        sql`${financialAccount.id} = ANY(${uuidArrayParam(ids)})`,
      ),
    );
}
