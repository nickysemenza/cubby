import type { EntityId } from "@cubby/schemas/identifiers";
import { and, desc, eq, exists, sql } from "drizzle-orm";

import type { Database, DrizzleTransaction } from "~/server/db";
import {
  aiUsage,
  importRun,
  importRunMutation,
  vendor,
  vendorAccount,
} from "~/server/db/schema";
import { getDb, notDeleted } from "~/server/repo/database-helpers";
import { resolveLiveShortcode } from "~/server/repo/shortcode-resolver";

/** Resolve the public Purchase id used by the ImportRunMutation target edge. */
export async function resolvePurchaseImportTarget(
  db: Database | DrizzleTransaction,
  purchaseShortcode: string,
) {
  return resolveLiveShortcode(db, purchaseShortcode, "purchase");
}

/** List only runs that recorded an actual mutation against this Purchase. */
export function listPurchaseImportRuns(
  db: Database,
  ledgerPartyId: EntityId<"ledgerParty">,
  purchaseId?: EntityId<"purchase">,
) {
  return getDb(db)
    .select({
      id: importRun.id,
      vendorAccountLabel: vendorAccount.label,
      vendorName: vendor.name,
      trigger: importRun.trigger,
      status: importRun.status,
      startedAt: importRun.startedAt,
      endedAt: importRun.endedAt,
      ordersSeen: importRun.ordersSeen,
      imported: importRun.imported,
      updated: importRun.updated,
      skipped: importRun.skipped,
      failureCode: importRun.failureCode,
      estimatedCost: sql<number>`coalesce(sum(${aiUsage.estimatedCost}), 0)`,
    })
    .from(importRun)
    .leftJoin(
      vendorAccount,
      and(
        eq(vendorAccount.id, importRun.vendorAccountId),
        notDeleted(vendorAccount),
      ),
    )
    .leftJoin(
      vendor,
      and(eq(vendor.id, vendorAccount.vendorId), notDeleted(vendor)),
    )
    .leftJoin(
      aiUsage,
      and(
        eq(aiUsage.jobKind, "purchase_import_run"),
        eq(aiUsage.jobId, sql<string>`${importRun.id}::text`),
        notDeleted(aiUsage),
      ),
    )
    .where(
      and(
        eq(importRun.ledgerPartyId, ledgerPartyId),
        purchaseId
          ? exists(
              getDb(db)
                .select({ id: importRunMutation.id })
                .from(importRunMutation)
                .where(
                  and(
                    eq(importRunMutation.runId, importRun.id),
                    eq(importRunMutation.targetType, "purchase"),
                    eq(importRunMutation.targetId, purchaseId),
                  ),
                ),
            )
          : undefined,
      ),
    )
    .groupBy(importRun.id, vendorAccount.label, vendor.name)
    .orderBy(desc(importRun.startedAt))
    .limit(purchaseId ? 100 : 20);
}
