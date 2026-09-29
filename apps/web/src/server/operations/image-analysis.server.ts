import { imageId } from "@cubby/schemas/identifiers";
import { and, eq, isNull, ne, or } from "drizzle-orm";

import type { LocalPhotoAnalysis } from "~/contracts/photo-import.contract";
import { runTarget } from "~/server/db/schema";
import type { EntityKernelContext } from "~/server/entity-kernel";
import { createAppError } from "~/server/errors/app-error";
import { getDb } from "~/server/repo/database-helpers";
import {
  getImportImageRows,
  getLocalImageAnalysis,
  persistLocalImageAnalysis,
} from "~/server/repo/photo-import";

/** The device's local analysis for an image, or `null` if nothing is persisted. */
export async function readImageAnalysis(
  context: EntityKernelContext,
  id: string,
): Promise<LocalPhotoAnalysis | null> {
  const [row] = await getImportImageRows(context.db, [id]);
  if (!row) return null;
  return getLocalImageAnalysis(context.db, row.id);
}

/**
 * Backfill a device-run analysis onto an already-uploaded image. Refuses when
 * the image isn't `UPLOADED` yet or the analysis was computed over different
 * bytes (`sha256` mismatch) — either means the analysis does not describe the
 * row it would be attached to.
 */
export async function recordImageAnalysis(
  context: EntityKernelContext,
  id: string,
  analysis: LocalPhotoAnalysis,
): Promise<{ saved: boolean }> {
  const [row] = await getImportImageRows(context.db, [id]);
  if (!row || row.status !== "UPLOADED" || row.sha256 !== analysis.sha256) {
    throw createAppError(
      "IMAGE_PRECONDITION_FAILED",
      `Image ${id} is not eligible for a local-analysis backfill`,
    );
  }
  await persistLocalImageAnalysis(
    context.db,
    row.id,
    analysis,
    analysis.analysisVersion,
    analysis.sha256,
  );
  // The device just finished processing this photo: reflect that on any
  // run target still tracking it, regardless of which run reported queued
  // or running earlier — `localAnalysisReady` reads this state instead of
  // inferring completion from AiAnalysis existing.
  await getDb(context.db)
    .update(runTarget)
    .set({ deviceWorkState: "completed", deviceWorkUpdatedAt: new Date() })
    .where(
      and(
        eq(runTarget.entityId, imageId.parse(row.id)),
        or(
          isNull(runTarget.deviceWorkState),
          ne(runTarget.deviceWorkState, "completed"),
        ),
      ),
    );
  return { saved: true };
}
