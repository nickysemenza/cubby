import { assessmentSubjects } from "@cubby/schemas/assessment";
import { imageDescriptionConfirmationOwner } from "@cubby/schemas/image-processing";
import type { SuggestionCorrectionSource } from "@cubby/schemas/suggestion-correction";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "~/server/db";
import { currentImageDescriptionConfirmation } from "~/server/db/computed/image-description-confirmation";
import { getDb } from "~/server/db/helpers";
import { assessment, assessmentState, image } from "~/server/db/schema";
import { readImageCorrectionSources } from "~/server/generic/assessment/repo/correction-sources";

type ImageCorrectionResolution =
  | { kind: "none" }
  | {
      kind: "confirmed";
      description: string;
      sources: SuggestionCorrectionSource[];
    }
  | { kind: "conflict"; sources: SuggestionCorrectionSource[] };

/** Text authority only: a correction cannot supply model claims or cutout eligibility. */
export async function resolveImageCorrection(
  db: Database,
  contentHash: string,
): Promise<ImageCorrectionResolution> {
  const candidates = await readImageCorrectionSources(db, contentHash);
  if (!candidates.length) return { kind: "none" };
  const current = await getDb(db)
    .select({
      id: assessmentState.id,
      correction: assessmentState.confirmedValue,
      data: assessmentState.data,
    })
    .from(assessmentState)
    .innerJoin(assessment, eq(assessment.id, assessmentState.id))
    .innerJoin(image, eq(image.id, assessmentState.recordId))
    .where(
      and(
        inArray(
          assessmentState.id,
          candidates.map((source) => source.assessmentId),
        ),
        currentImageDescriptionConfirmation(),
        eq(assessmentState.status, "applied"),
        isNull(assessmentState.suppression),
      ),
    );
  const byId = new Map(current.map((row) => [row.id, row]));
  const sources = candidates.filter((source) => {
    const subject = assessmentSubjects.image_description.safeParse(
      source.subject,
    );
    const row = byId.get(source.assessmentId);
    const correction = row?.correction;
    const ownership = z
      .object({
        confirmationOwner: imageDescriptionConfirmationOwner.optional(),
      })
      .safeParse(row?.data ?? {});
    if (!ownership.success) return false;
    const owner = ownership.data.confirmationOwner;
    if (
      owner &&
      (owner.kind !== "member" ||
        owner.commandFeedbackId !== source.feedbackId ||
        owner.actorUserId !== source.actorUserId)
    )
      return false;
    return (
      subject.success &&
      subject.data.contentHash === contentHash &&
      typeof source.correctedValue === "string" &&
      correction?.present === true &&
      correction.value === source.correctedValue
    );
  });
  const descriptions = new Set(sources.map((source) => source.correctedValue));
  if (!sources.length) return { kind: "none" };
  if (descriptions.size > 1) return { kind: "conflict", sources };
  const description = sources[0]?.correctedValue;
  if (typeof description !== "string")
    throw new Error("Confirmed image correction has no text");
  return { kind: "confirmed", description, sources };
}
