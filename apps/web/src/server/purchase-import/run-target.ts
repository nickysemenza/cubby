import type { EntityId } from "@cubby/schemas/identifiers";
import type { RunTargetDeviceWorkState } from "@cubby/schemas/photo-import-run";
import { and, desc, eq, exists, or, type SQL, sql } from "drizzle-orm";

import type { Database, DrizzleTransaction } from "~/server/db";
import {
  aiUsage,
  auditLog,
  run as runTable,
  runTarget,
  vendor,
  vendorAccount,
} from "~/server/db/schema";
import {
  getDb,
  notDeleted,
  withTransaction,
} from "~/server/repo/database-helpers";
import {
  resolveLiveShortcode,
  resolveOrThrow,
} from "~/server/repo/shortcode-resolver";

/** Resolve the public Purchase id a Run's AuditLog rows name. */
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

/**
 * Run summaries for one household party, newest first, with their AI spend.
 * `where` narrows to the runs that concern one target; `undefined` lists the
 * party's 20 most recent runs.
 */
function runSummaryQuery(
  db: Database,
  ledgerPartyId: EntityId<"ledgerParty">,
  where: SQL | undefined,
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
      estimatedCost: sql<number | null>`case
        when count(${aiUsage.id}) filter (where ${aiUsage.estimatedCost} is null) > 0 then null
        else coalesce(sum(${aiUsage.estimatedCost}), 0)
      end`,
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
    .where(and(eq(runTable.ledgerPartyId, ledgerPartyId), where))
    .groupBy(runTable.id, vendorAccount.label, vendor.name)
    .orderBy(desc(runTable.startedAt));

  return where ? query : query.limit(20);
}

/** A run that targets `entityId` through a `RunTarget` row. */
const runTargets = (db: Database, entityId: EntityId<"purchase" | "product">) =>
  exists(
    getDb(db)
      .select({ id: runTarget.id })
      .from(runTarget)
      .where(
        and(eq(runTarget.runId, runTable.id), eq(runTarget.entityId, entityId)),
      ),
  );

/** List write provenance and targeted no-op validation runs for a Purchase. */
export function listRuns(
  db: Database,
  ledgerPartyId: EntityId<"ledgerParty">,
  purchaseId?: EntityId<"purchase">,
) {
  return runSummaryQuery(
    db,
    ledgerPartyId,
    purchaseId
      ? or(
          exists(
            getDb(db)
              .select({ id: auditLog.id })
              .from(auditLog)
              .where(
                and(
                  eq(auditLog.runId, runTable.id),
                  eq(auditLog.entityKind, "purchase"),
                  eq(auditLog.entityId, purchaseId),
                ),
              ),
          ),
          runTargets(db, purchaseId),
        )
      : undefined,
  );
}

/** List write provenance and targeted enrichment runs for a Product. */
export function listProductRuns(
  db: Database,
  ledgerPartyId: EntityId<"ledgerParty">,
  productId?: EntityId<"product">,
) {
  return runSummaryQuery(
    db,
    ledgerPartyId,
    productId ? runTargets(db, productId) : undefined,
  );
}

/**
 * Idempotent device-side status for one photo-run image target
 * (`run.reportDeviceWork`). Repeating the same {run, image, state} is a
 * no-op: the report only updates the row when the state actually changes,
 * so a retried or duplicated device message never double-counts an attempt.
 */
export async function reportRunTargetDeviceWork(
  db: Database,
  input: {
    run: string;
    image: string;
    state: RunTargetDeviceWorkState;
    error?: string;
  },
): Promise<{ recorded: boolean }> {
  const runId = await resolveOrThrow(db, "run", input.run);
  const imageId = await resolveOrThrow(db, "image", input.image);
  return withTransaction(db, async (tx) => {
    const [target] = await tx
      .select({
        id: runTarget.id,
        deviceWorkState: runTarget.deviceWorkState,
        deviceWorkAttempts: runTarget.deviceWorkAttempts,
      })
      .from(runTarget)
      .where(and(eq(runTarget.runId, runId), eq(runTarget.entityId, imageId)))
      .for("update");
    if (!target)
      throw new Error("This run has no photo target for that image.");
    if (target.deviceWorkState === input.state) return { recorded: true };
    await tx
      .update(runTarget)
      .set({
        deviceWorkState: input.state,
        deviceWorkError:
          input.state === "failed" ? (input.error ?? null) : null,
        deviceWorkAttempts:
          input.state === "failed"
            ? target.deviceWorkAttempts + 1
            : target.deviceWorkAttempts,
        deviceWorkUpdatedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(runTarget.id, target.id));
    return { recorded: true };
  });
}
