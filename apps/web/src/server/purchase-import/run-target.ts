import type { EntityId } from "@cubby/schemas/identifiers";
import { and, desc, eq, exists, or, sql } from "drizzle-orm";

import type { Database, DrizzleTransaction } from "~/server/db";
import {
  aiUsage,
  importRun,
  importRunMutation,
  importRunTarget,
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

/** Resolve the public Product id used by a targeted enrichment run. */
export async function resolveProductImportTarget(
  db: Database | DrizzleTransaction,
  productShortcode: string,
) {
  return resolveLiveShortcode(db, productShortcode, "product");
}

/** List write provenance and targeted no-op validation runs for a Purchase. */
export function listPurchaseImportRuns(
  db: Database,
  ledgerPartyId: EntityId<"ledgerParty">,
  purchaseId?: EntityId<"purchase">,
) {
  const query = getDb(db)
    .select({
      id: importRun.id,
      publicId: importRun.publicId,
      vendorAccountLabel: vendorAccount.label,
      vendorName: vendor.name,
      trigger: importRun.trigger,
      purpose: importRun.purpose,
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
          ? or(
              exists(
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
              ),
              exists(
                getDb(db)
                  .select({ id: importRunTarget.id })
                  .from(importRunTarget)
                  .where(
                    and(
                      eq(importRunTarget.runId, importRun.id),
                      eq(importRunTarget.purchaseId, purchaseId),
                    ),
                  ),
              ),
            )
          : undefined,
      ),
    )
    .groupBy(importRun.id, vendorAccount.label, vendor.name)
    .orderBy(desc(importRun.startedAt));

  return purchaseId ? query : query.limit(20);
}

/** List write provenance and targeted enrichment runs for a Product. */
export function listProductImportRuns(
  db: Database,
  ledgerPartyId: EntityId<"ledgerParty">,
  productId?: EntityId<"product">,
) {
  const query = getDb(db)
    .select({
      id: importRun.id,
      publicId: importRun.publicId,
      vendorAccountLabel: vendorAccount.label,
      vendorName: vendor.name,
      trigger: importRun.trigger,
      purpose: importRun.purpose,
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
        productId
          ? exists(
              getDb(db)
                .select({ id: importRunTarget.id })
                .from(importRunTarget)
                .where(
                  and(
                    eq(importRunTarget.runId, importRun.id),
                    eq(importRunTarget.productId, productId),
                  ),
                ),
            )
          : undefined,
      ),
    )
    .groupBy(importRun.id, vendorAccount.label, vendor.name)
    .orderBy(desc(importRun.startedAt));

  return productId ? query : query.limit(20);
}
