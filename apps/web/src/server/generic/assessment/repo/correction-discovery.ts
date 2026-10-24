import { assessmentSubjects } from "@cubby/schemas/assessment";
import type {
  SuggestionCorrectionSource,
  SuggestionCorrectionTarget,
} from "@cubby/schemas/suggestion-correction";
import { and, asc, eq, sql } from "drizzle-orm";

import type { Database } from "~/server/db";
import { getDb } from "~/server/db/helpers";
import { assessment, assessmentState } from "~/server/db/schema";
import { resolveImageCorrection } from "~/server/domains/image/repo/image-correction-resolver";
import {
  correctionTargetIds,
  readFieldCorrectionIdentity,
  readFieldCorrectionSources,
} from "~/server/generic/assessment/repo/correction-sources";
import { fieldCorrectionIdentityKeys } from "~/server/generic/assessment/repo/field-assessment-review";

/** Discovery is advisory; each domain revalidates authority inside its application fence. */
export async function correctionSourcesForTarget(
  db: Database,
  target: SuggestionCorrectionTarget,
) {
  if (target.family === "field") {
    const scope = assessmentSubjects.field.parse(target.subject);
    const identity = await readFieldCorrectionIdentity(
      db,
      target.subject,
      target.evidence,
    );
    const keys = fieldCorrectionIdentityKeys(identity);
    return keys.length ? readFieldCorrectionSources(db, keys, scope) : [];
  }
  if (target.family === "image_description") {
    const { contentHash } = assessmentSubjects.image_description.parse(
      target.subject,
    );
    if (!contentHash) return [];
    const resolution = await resolveImageCorrection(db, contentHash);
    return resolution.kind === "none" ? [] : resolution.sources;
  }
  return [];
}

export async function correctionTargetsForSource(
  db: Database,
  source: SuggestionCorrectionSource,
  cursor: { after: string | null; limit: number },
) {
  if (source.family === "field") {
    const scope = assessmentSubjects.field.parse(source.subject);
    const identity = await readFieldCorrectionIdentity(
      db,
      source.subject,
      source.evidence,
    );
    const keys = fieldCorrectionIdentityKeys(identity);
    if (keys.length)
      return correctionTargetIds(db, {
        sourceAssessmentId: source.assessmentId,
        correctionKey: keys,
        entity: scope.entity,
        field: scope.field,
        ...cursor,
      });
  }
  if (source.family === "image_description") {
    const { contentHash } = assessmentSubjects.image_description.parse(
      source.subject,
    );
    if (contentHash) {
      const targets = await getDb(db)
        .select({ id: assessment.id })
        .from(assessment)
        .innerJoin(assessmentState, eq(assessmentState.id, assessment.id))
        .where(
          and(
            eq(assessment.family, "image_description"),
            eq(assessment.served, true),
            eq(assessmentState.active, true),
            sql`${assessment.id} <> ${source.assessmentId}::uuid`,
            sql`${assessment.subject}->>'contentHash' = ${contentHash}`,
            cursor.after
              ? sql`${assessment.id} > ${cursor.after}::uuid`
              : undefined,
          ),
        )
        .orderBy(asc(assessment.id))
        .limit(cursor.limit);
      return {
        targets,
        after: targets.at(-1)?.id ?? cursor.after,
        done: targets.length < cursor.limit,
      };
    }
  }
  return {
    targets: [{ id: source.assessmentId }],
    after: cursor.after,
    done: true,
  };
}
