import { type ImageId } from "@cubby/schemas/identifiers";
import {
  imageDescriptionConfirmationOwner,
  imageDescriptionCorrectionReceipt,
} from "@cubby/schemas/image-processing";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { isEqual } from "es-toolkit";
import { z } from "zod";

import { currentImageDescriptionConfirmation } from "~/server/db/computed/image-description-confirmation";
import { type Database } from "~/server/db/database";
import {
  repositoryQueries as getDb,
  type RepositoryQueryInput,
} from "~/server/db/repository-access.boundary";
import {
  assessmentState,
  assessment,
  image,
  feedback,
} from "~/server/db/retained-tables";
import {
  correctionOperationId,
  readCorrectionReceipts,
} from "~/server/generic/assessment/repo/correction-receipt";

/** Shared direct/batch selection verifies automatic effect receipts once per requested page. */
export async function readImageDescriptionConfirmations(
  db: RepositoryQueryInput,
  scope: { imageIds: readonly ImageId[] } | { shortcodes: readonly string[] },
) {
  const ids = "imageIds" in scope ? scope.imageIds : scope.shortcodes;
  if (!ids.length) return [];
  const rows = await getDb(db)
    .select({
      assessmentId: assessmentState.id,
      imageId: image.id,
      shortcode: image.shortcode,
      contentHash: image.sha256,
      description: sql<string>`${assessmentState.confirmedValue}->>'value'`,
      data: assessmentState.data,
      confirmedAt:
        sql<Date>`coalesce((SELECT max(f."createdAt") FROM ${feedback} f WHERE f."assessmentId"=${assessmentState.id} AND f.metadata @> ${JSON.stringify({ kind: "assessment_application" })}::jsonb AND f.receipt @> ${JSON.stringify({ applied: true })}::jsonb),(${assessmentState.data}->>'confirmedAt')::timestamp,${assessmentState.updatedAt})`.mapWith(
          assessmentState.updatedAt,
        ),
    })
    .from(assessmentState)
    .innerJoin(assessment, eq(assessment.id, assessmentState.id))
    .innerJoin(image, eq(image.id, assessmentState.recordId))
    .where(
      and(
        "imageIds" in scope
          ? inArray(image.id, [...scope.imageIds])
          : inArray(image.shortcode, [...scope.shortcodes]),
        currentImageDescriptionConfirmation(),
      ),
    )
    .orderBy(desc(assessmentState.updatedAt));
  const prepared = rows.flatMap((row) => {
    const ownership = z
      .object({
        confirmationOwner: imageDescriptionConfirmationOwner.optional(),
      })
      .safeParse(row.data ?? {});
    return ownership.success
      ? [{ ...row, owner: ownership.data.confirmationOwner ?? null }]
      : [];
  });
  const automatic = prepared.flatMap((row) =>
    row.owner?.kind === "correction"
      ? [
          {
            sourceFeedbackId: row.owner.sourceFeedbackId,
            targetAssessmentId: row.owner.targetAssessmentId,
          },
        ]
      : [],
  );
  const receipts = await readCorrectionReceipts(db, automatic);
  return prepared.filter((row) => {
    if (row.owner?.kind !== "correction") return true;
    const found = receipts.get(
      correctionOperationId(
        row.owner.sourceFeedbackId,
        row.owner.targetAssessmentId,
      ),
    );
    if (found?.kind !== "valid") return false;
    const effect = z
      .object({
        status: z.literal("applied"),
        receipt: imageDescriptionCorrectionReceipt,
      })
      .safeParse(found.receipt.receipt);
    const lineage = z
      .object({
        sourceApplicationFeedbackId: z.string(),
        sourceActorUserId: z.string(),
      })
      .safeParse(found.receipt.metadata);
    return (
      effect.success &&
      lineage.success &&
      lineage.data.sourceApplicationFeedbackId ===
        row.owner.sourceApplicationFeedbackId &&
      lineage.data.sourceActorUserId === row.owner.sourceActorUserId &&
      row.owner.targetAssessmentId === row.assessmentId &&
      effect.data.receipt.recordId === row.imageId &&
      effect.data.receipt.contentHash === row.contentHash &&
      effect.data.receipt.description === row.description &&
      isEqual(effect.data.receipt.owner, row.owner)
    );
  });
}

export async function readConfirmedDescription(db: Database, imageId: ImageId) {
  const [row] = await readImageDescriptionConfirmations(db, {
    imageIds: [imageId],
  });
  return row
    ? {
        description: row.description,
        confirmedAt: row.confirmedAt,
        owner: row.owner,
      }
    : null;
}
