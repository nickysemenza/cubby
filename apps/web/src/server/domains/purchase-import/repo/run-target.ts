import type { EntityId, EntityRef, RunId } from "@cubby/schemas/identifiers";
import type { RunTargetDeviceWorkState } from "@cubby/schemas/photo-import-run";
import {
  runTargetOutcomeReceipt,
  type RunTargetOutcomeReceipt,
} from "@cubby/schemas/run-fields";
import {
  and,
  asc,
  desc,
  eq,
  exists,
  inArray,
  or,
  type SQL,
  sql,
} from "drizzle-orm";

import { aiCostSummarySql } from "~/server/ai/repo/ai-usage";
import type { Database, DrizzleClient, DrizzleTransaction } from "~/server/db";
import { vendorAccountLabelSql } from "~/server/db/computed/vendor-account-label";
import {
  getDb,
  notDeleted,
  withTransaction,
  unwrapDb,
} from "~/server/db/helpers";
import {
  aiUsage,
  auditLog,
  run as runTable,
  photoRunImage,
  runFinding,
  runOperation,
  vendor,
  vendorAccount,
} from "~/server/db/schema";
import {
  resolveLiveShortcode,
  resolveOrThrow,
} from "~/server/generic/shortcode/repo/shortcode-resolver";

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
      vendorAccountLabel: sql<string | null>`${vendorAccountLabelSql}`,
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
      ...aiCostSummarySql(),
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
    .groupBy(runTable.id, vendorAccount.id, vendor.name)
    .orderBy(desc(runTable.startedAt));

  return where ? query : query.limit(20);
}

export type RunTargetOutcome = Pick<
  typeof runOperation.$inferSelect,
  "id" | "runId" | "operationId"
> &
  RunTargetOutcomeReceipt["target"];

/** Immutable migrated outcomes retain no-op attribution after targets retire. */
export async function listRunTargetOutcomes(
  db: Database | DrizzleClient | DrizzleTransaction,
  runIds: readonly RunId[],
  subject?: EntityRef,
): Promise<RunTargetOutcome[]> {
  if (!runIds.length) return [];
  const client = "select" in db ? db : unwrapDb(db);
  const receipts = await client
    .select({
      id: runOperation.id,
      runId: runOperation.runId,
      operationId: runOperation.operationId,
      result: runOperation.result,
    })
    .from(runOperation)
    .where(
      and(
        inArray(runOperation.runId, [...runIds]),
        eq(runOperation.kind, "target_outcome"),
        eq(runOperation.state, "completed"),
        subject
          ? sql`${runOperation.result}->${"target"}->>'entityKind' = ${subject.entity} AND ${runOperation.result}->${"target"}->>'entityId' = ${subject.id}`
          : undefined,
      ),
    )
    .orderBy(asc(runOperation.startedAt), asc(runOperation.id));
  return receipts.map(({ result, ...receipt }) => ({
    ...receipt,
    ...runTargetOutcomeReceipt.parse(result).target,
  }));
}

const runSubjectHistory = (
  db: Database,
  subject: EntityRef<"purchase" | "product">,
) =>
  or(
    exists(
      getDb(db)
        .select({ id: auditLog.id })
        .from(auditLog)
        .where(
          and(
            eq(auditLog.runId, runTable.id),
            eq(auditLog.entityKind, subject.entity),
            eq(auditLog.entityId, subject.id),
          ),
        ),
    ),
    exists(
      getDb(db)
        .select({ id: runFinding.id })
        .from(runFinding)
        .where(
          and(
            eq(runFinding.runId, runTable.id),
            eq(runFinding.entityKind, subject.entity),
            eq(runFinding.entityId, subject.id),
          ),
        ),
    ),
    exists(
      getDb(db)
        .select({ id: runOperation.id })
        .from(runOperation)
        .where(
          and(
            eq(runOperation.runId, runTable.id),
            eq(runOperation.kind, "target_outcome"),
            eq(runOperation.state, "completed"),
            sql`${runOperation.result}->${"target"}->>'entityKind' = ${subject.entity} AND ${runOperation.result}->${"target"}->>'entityId' = ${subject.id}`,
          ),
        ),
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
      ? runSubjectHistory(db, { entity: "purchase", id: purchaseId })
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
    productId
      ? runSubjectHistory(db, { entity: "product", id: productId })
      : undefined,
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
        id: photoRunImage.id,
        deviceWorkState: photoRunImage.deviceWorkState,
        deviceWorkAttempts: photoRunImage.deviceWorkAttempts,
      })
      .from(photoRunImage)
      .where(
        and(eq(photoRunImage.runId, runId), eq(photoRunImage.imageId, imageId)),
      )
      .for("update");
    if (!target)
      throw new Error("This run has no photo target for that image.");
    if (target.deviceWorkState === input.state) return { recorded: true };
    await tx
      .update(photoRunImage)
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
      .where(eq(photoRunImage.id, target.id));
    return { recorded: true };
  });
}
