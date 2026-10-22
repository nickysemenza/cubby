import {
  mailImportOutcome,
  type AssessmentProducer,
} from "@cubby/schemas/assessment";
import type { RunId } from "@cubby/schemas/identifiers";
import { sha256Hex } from "@cubby/shared/sha256";
import { and, eq, ne, inArray } from "drizzle-orm";
import type { z } from "zod";

import type { Database } from "~/server/db";
import { getDb, notDeleted } from "~/server/db/helpers";
import {
  assessment,
  assessmentState,
  expense,
  purchase,
  vendor,
} from "~/server/db/schema";
import { publishAssessment } from "~/server/generic/assessment/repo/assessment";
import { transitionAssessmentStates } from "~/server/generic/assessment/repo/assessment-state";

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

/** Settlement history and its current review projection commit with the Email. */
export async function publishMailImportOutcome(
  db: Database,
  input: {
    emailId: string;
    runId: RunId;
    checksum: string;
    judgment: z.infer<typeof mailImportOutcome>;
    ruleRevision?: string;
  },
) {
  const fingerprint = await sha256Hex(
    JSON.stringify({ checksum: input.checksum, judgment: input.judgment }),
  );
  const publicationKey = `mail-import-outcome:${input.runId}:${input.emailId}:${fingerprint}`;
  // A recovered tool can run after another model turn; its original producer
  // belongs to its first committed outcome, never the latest usage on retry.
  const [existing] = await getDb(db)
    .select({ id: assessment.id })
    .from(assessment)
    .where(eq(assessment.publicationKey, publicationKey))
    .limit(1);
  if (existing) return existing;
  // Run-level usage can arrive asynchronously or name an earlier turn. Only
  // a model receipt causally bound to this settlement may fill producer.model.
  const producer: AssessmentProducer = {
    kind: input.ruleRevision ? "rule" : "agent",
    model: null,
    revision: input.ruleRevision ?? null,
    runId: input.runId,
    evaluationId: null,
  };
  const published = await publishAssessment(
    db,
    {
      publicationKey,
      family: "mail_import_outcome",
      subject: {
        kind: "mail_import_outcome",
        entity: "email",
        recordId: input.emailId,
        checksum: input.checksum,
        runId: input.runId,
      },
      judgment: input.judgment,
      fingerprint,
      producer,
      evidence: { checksum: input.checksum },
    },
    { runId: input.runId, model: producer.model ?? "unknown" },
  );
  // Preserve every historical outcome; only the newest result is a current
  // review candidate for the same Run and Email.
  await transitionAssessmentStates(
    db,
    and(
      eq(assessmentState.family, "mail_import_outcome"),
      ne(assessmentState.id, published.id),
      eq(assessmentState.runId, input.runId),
      eq(assessmentState.recordId, input.emailId),
    ),
    { active: false, status: "superseded" },
    { kind: "superseded_by_publication" },
  );
  return published;
}
