import { and, sql } from "drizzle-orm";

import type { Database, DrizzleTransaction } from "~/server/db";
import { notDeleted, unwrapDb, uuidArrayParam } from "~/server/db/helpers";
import { financialAccount } from "~/server/db/retained-tables";
import { entityDisplayImagePresenceSql } from "~/server/entity-kernel/repo/entity-display-image";
import { qualityCheck } from "~/server/generic/data-quality/repo/builders";
import { defineStoredEntityChecks } from "~/server/generic/data-quality/repo/stored-registry";

/** Bump when the rules or their declared scoring metadata change. */
const FINANCIAL_ACCOUNT_QUALITY_RULES_VERSION = 1;
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
    // Cash has no provider to claim it; the account itself is evidence.
    financial_account_unclaimed: observed(
      (r) =>
        !r.provisional ||
        r.identity.kind === "cash" ||
        r.hasSourceAliases ||
        r.hasSettlementReference,
    ),
    financial_account_ledger_party: observed((r) => r.ledgerPartyId !== null),
    financial_account_confirmed: observed((r) => !r.provisional),
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
      provisional: financialAccount.provisional,
      identity: financialAccount.identity,
      ledgerPartyId: financialAccount.ledgerPartyId,
      hasSourceAliases: sql<boolean>`CASE WHEN jsonb_typeof(${financialAccount.sourceAliases}) = 'array' THEN jsonb_array_length(${financialAccount.sourceAliases}) > 0 ELSE false END`,
      hasSettlementReference: sql<boolean>`EXISTS (
      SELECT 1 FROM "FinancialTransaction" ft
      JOIN "EntityExternalId" fx ON fx."entityId" = ft.id
        AND fx.kind = 'settlement_ref' AND fx."deletedAt" IS NULL
      WHERE ft."accountId" = "FinancialAccount"."id" AND ft."deletedAt" IS NULL
    )`,
    })
    .from(financialAccount)
    .where(
      and(
        notDeleted(financialAccount),
        sql`${financialAccount.id} = ANY(${uuidArrayParam(ids)})`,
      ),
    );
}
