import { assessmentSubjects } from "@cubby/schemas/assessment";
import type { SuggestionCorrectionSource } from "@cubby/schemas/suggestion-correction";
import { and, eq, inArray, isNull } from "drizzle-orm";

import type { Database } from "~/server/db";
import { getDb } from "~/server/db/helpers";
import { assessment, assessmentState, image } from "~/server/db/schema";
import { currentImageDescriptionConfirmation } from "~/server/generic/assessment/repo/assessment-image";
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
  const byId = new Map(current.map((row) => [row.id, row.correction]));
  const sources = candidates.filter((source) => {
    const subject = assessmentSubjects.image_description.safeParse(
      source.subject,
    );
    const correction = byId.get(source.assessmentId);
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
