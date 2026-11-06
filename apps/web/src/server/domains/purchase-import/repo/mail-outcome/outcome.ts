import type { RunId } from "@cubby/schemas/identifiers";
import {
  mailOutcomeSnapshot,
  type MailOutcomeSnapshot,
} from "@cubby/schemas/mail-import-outcome";
import {
  mailImportOutcome,
  type SuggestionProducer,
} from "@cubby/schemas/suggestion";
import { sha256Hex } from "@cubby/shared/sha256";
import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "~/server/db";
import { getDb, notDeleted } from "~/server/db/helpers";
import { expense, purchase, runOperation, vendor } from "~/server/db/schema";

/** Freeze every Purchase reached by this Email commit, including credits and unknown costs. */
export async function importedMailJudgment(
  db: Database,
  purchaseIds: NonNullable<typeof expense.$inferSelect.purchaseId>[],
) {
  const lines = await getDb(db)
    .select({ name: expense.name, cost: expense.cost })
    .from(expense)
    .where(and(inArray(expense.purchaseId, purchaseIds), notDeleted(expense)))
    .orderBy(expense.id);
  return mailImportOutcome.parse({
    kind: "imported",
    lines,
    total: lines.some((line) => line.cost !== null)
      ? lines.reduce(
          (cents, line) => cents + Math.round((line.cost ?? 0) * 100),
          0,
        ) / 100
      : null,
  });
}

/** Database UUIDs change on replay; order/vendor evidence names the linked target. */
export async function linkedMailJudgment(
  db: Database,
  input: {
    purchaseIds: NonNullable<typeof expense.$inferSelect.purchaseId>[];
    event: string;
  },
) {
  const purchases = input.purchaseIds.length
    ? await getDb(db)
        .select({ orderId: purchase.orderId, vendor: vendor.name })
        .from(purchase)
        .leftJoin(vendor, eq(vendor.id, purchase.vendorId))
        .where(
          and(inArray(purchase.id, input.purchaseIds), notDeleted(purchase)),
        )
        .orderBy(purchase.id)
    : [];
  return mailImportOutcome.parse({
    kind: "linked",
    event: input.event,
    purchases,
  });
}

/**
 * The frozen result stored on the Email's `target_outcome`. Run-level usage can
 * arrive asynchronously or name an earlier turn, so only a model receipt
 * causally bound to this settlement could fill producer.model.
 */
export async function mailOutcomeSnapshotFor(input: {
  runId: RunId;
  checksum: string;
  judgment: z.infer<typeof mailImportOutcome>;
  ruleRevision?: string;
  createdAt: Date;
}): Promise<MailOutcomeSnapshot> {
  const producer: SuggestionProducer = {
    kind: input.ruleRevision ? "rule" : "agent",
    model: null,
    revision: input.ruleRevision ?? null,
    runId: input.runId,
    evaluationId: null,
  };
  return mailOutcomeSnapshot.parse({
    id: crypto.randomUUID(),
    judgment: input.judgment,
    producer,
    checksum: input.checksum,
    fingerprint: await sha256Hex(
      JSON.stringify({ checksum: input.checksum, judgment: input.judgment }),
    ),
    createdAt: input.createdAt.toISOString(),
  });
}

/** A `target_outcome` carrying a frozen result. */
export const storedMailOutcome = z.object({ mailOutcome: mailOutcomeSnapshot });

const isMailOutcome = sql`${runOperation.kind} = ${"target_outcome"} AND (${runOperation.result}->'mailOutcome') IS NOT NULL`;

export const mailOutcomeOfEmailSql = (emailId: string): SQL =>
  sql`${isMailOutcome} AND (${runOperation.result} #>> '{target,entityId}') = ${emailId}`;

export const mailOutcomeByHandleSql = (id: string): SQL =>
  sql`${isMailOutcome} AND (${runOperation.result} #>> '{mailOutcome,id}') = ${id}`;
