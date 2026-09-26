import type { EntityId } from "@cubby/schemas/identifiers";
import { and, desc, eq, exists, or, sql } from "drizzle-orm";

import type { Database, DrizzleTransaction } from "~/server/db";
import {
  aiUsage,
  run as runTable,
  runMutation,
  runTarget,
  vendor,
  vendorAccount,
} from "~/server/db/schema";
import { getDb, notDeleted } from "~/server/repo/database-helpers";
import { resolveLiveShortcode } from "~/server/repo/shortcode-resolver";

/** Resolve the public Purchase id used by the RunMutation target edge. */
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
export function listRuns(
  db: Database,
  ledgerPartyId: EntityId<"ledgerParty">,
  purchaseId?: EntityId<"purchase">,
) {
  const query = getDb(db)
    .select({
      id: runTable.id,
      publicId: runTable.shortcode,
      vendorAccountLabel: vendorAccount.label,
      vendorName: vendor.name,
      trigger: runTable.trigger,
      purpose: runTable.purpose,
      status: runTable.status,
      startedAt: runTable.startedAt,
      endedAt: runTable.endedAt,
      ordersSeen: runTable.ordersSeen,
      imported: runTable.imported,
      updated: runTable.updated,
      skipped: runTable.skipped,
      failureCode: runTable.failureCode,
      estimatedCost: sql<number>`coalesce(sum(${aiUsage.estimatedCost}), 0)`,
    })
    .from(runTable)
    .leftJoin(
      vendorAccount,
      and(
        eq(vendorAccount.id, runTable.vendorAccountId),
        notDeleted(vendorAccount),
      ),
    )
    .leftJoin(
      vendor,
      and(eq(vendor.id, vendorAccount.vendorId), notDeleted(vendor)),
    )
    .leftJoin(aiUsage, and(eq(aiUsage.runId, runTable.id), notDeleted(aiUsage)))
    .where(
      and(
        eq(runTable.ledgerPartyId, ledgerPartyId),
        purchaseId
          ? or(
              exists(
                getDb(db)
                  .select({ id: runMutation.id })
                  .from(runMutation)
                  .where(
                    and(
                      eq(runMutation.runId, runTable.id),
                      eq(runMutation.targetType, "purchase"),
                      eq(runMutation.targetId, purchaseId),
                    ),
                  ),
              ),
              exists(
                getDb(db)
                  .select({ id: runTarget.id })
                  .from(runTarget)
                  .where(
                    and(
                      eq(runTarget.runId, runTable.id),
                      eq(runTarget.purchaseId, purchaseId),
                    ),
                  ),
              ),
            )
          : undefined,
      ),
    )
    .groupBy(runTable.id, vendorAccount.label, vendor.name)
    .orderBy(desc(runTable.startedAt));

  return purchaseId ? query : query.limit(20);
}

/** List write provenance and targeted enrichment runs for a Product. */
export function listProductRuns(
  db: Database,
  ledgerPartyId: EntityId<"ledgerParty">,
  productId?: EntityId<"product">,
) {
  const query = getDb(db)
    .select({
      id: runTable.id,
      publicId: runTable.shortcode,
      vendorAccountLabel: vendorAccount.label,
      vendorName: vendor.name,
      trigger: runTable.trigger,
      purpose: runTable.purpose,
      status: runTable.status,
      startedAt: runTable.startedAt,
      endedAt: runTable.endedAt,
      ordersSeen: runTable.ordersSeen,
      imported: runTable.imported,
      updated: runTable.updated,
      skipped: runTable.skipped,
      failureCode: runTable.failureCode,
      estimatedCost: sql<number>`coalesce(sum(${aiUsage.estimatedCost}), 0)`,
    })
    .from(runTable)
    .leftJoin(
      vendorAccount,
      and(
        eq(vendorAccount.id, runTable.vendorAccountId),
        notDeleted(vendorAccount),
      ),
    )
    .leftJoin(
      vendor,
      and(eq(vendor.id, vendorAccount.vendorId), notDeleted(vendor)),
    )
    .leftJoin(aiUsage, and(eq(aiUsage.runId, runTable.id), notDeleted(aiUsage)))
    .where(
      and(
        eq(runTable.ledgerPartyId, ledgerPartyId),
        productId
          ? exists(
              getDb(db)
                .select({ id: runTarget.id })
                .from(runTarget)
                .where(
                  and(
                    eq(runTarget.runId, runTable.id),
                    eq(runTarget.productId, productId),
                  ),
                ),
            )
          : undefined,
      ),
    )
    .groupBy(runTable.id, vendorAccount.label, vendor.name)
    .orderBy(desc(runTable.startedAt));

  return productId ? query : query.limit(20);
}
