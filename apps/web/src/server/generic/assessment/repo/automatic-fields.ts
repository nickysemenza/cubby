import { suggestionStatus, fieldSuggestionsInput } from "@cubby/schemas/ai";
import {
  assessmentFamily,
  assessmentSubjects,
  feedbackAuthority,
  feedbackVerdict,
} from "@cubby/schemas/assessment";
/** Current field decisions backed by Automatic rule applications, never model confidence alone. */
import { auditLogActionSchema } from "@cubby/schemas/audit";
import type { Entity } from "@cubby/schemas/entity";
import {
  entityFieldByKey,
  entityFieldModels,
} from "@cubby/schemas/entity-fields";
import { fieldAssignmentOwnership } from "@cubby/schemas/field-envelope";
import { sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";

import { notDeleted } from "~/server/db/helpers/predicates";
import { uuidArrayParam } from "~/server/db/helpers/query";
import type { RepositoryQueryInput } from "~/server/db/repository-access.boundary";
import { repositoryQueries as unwrapDb } from "~/server/db/repository-access.boundary";
import { SHORTCODE_TABLE } from "~/server/generated/shortcode-tables.gen";
import { automaticApplicationRule } from "~/server/generic/assessment/repo/assessment";
import type { CurrentFieldOwnership } from "~/server/generic/derived/repo/read-context";
export type { CurrentFieldOwnership } from "~/server/generic/derived/repo/read-context";

const currentOwnership = z.record(
  z.string(),
  fieldAssignmentOwnership.options[1],
);

/** Receipt and audit checks establish current authority in one page query. */
export async function loadCurrentFieldOwnership(
  db: RepositoryQueryInput,
  entity: Entity,
  ids: readonly string[],
): Promise<Map<string, CurrentFieldOwnership>> {
  const eligibleEntity = fieldSuggestionsInput.shape.entity.safeParse(entity);
  if (!ids.length || !eligibleEntity.success) return new Map();
  if (
    !entityFieldModels[entity].fields.some(
      (field) =>
        field.control?.suggest?.mode === "fill" &&
        !field.control.suggest.reviewRequired,
    )
  )
    return new Map();
  const table = alias(SHORTCODE_TABLE[eligibleEntity.data], "t");
  const tableName = SHORTCODE_TABLE[eligibleEntity.data];
  const rows = await unwrapDb(db).execute<{
    id: string;
    value: unknown;
  }>(sql`
          SELECT t.id::text AS id, COALESCE((
            SELECT jsonb_object_agg(s.field, jsonb_build_object(${fieldAssignmentOwnership.options[1].keyof().enum.kind}::text, ${fieldAssignmentOwnership.options[1].shape.kind.value}::text, 'receiptId', s.id::text, 'confidence',
              (s."acceptanceReceipt"->>'confidence')::double precision))
            FROM "AssessmentState" s JOIN "Assessment" a ON a.id = s.id
            WHERE s.entity = ${entity} AND s."recordId" = t.id
              AND s.family = ${assessmentFamily.enum.field} AND s.status = ${suggestionStatus.enum.applied}
              AND a.subject->>'entity' = s.entity AND a.subject->>${assessmentSubjects.field.keyof().enum.field} = s.field
              AND a.subject->>'recordId' = t.id::text
              AND s."acceptanceReceipt"->>'mode' = ${feedbackAuthority.enum.automatic}
              AND jsonb_typeof(s."acceptanceReceipt"->'confidence') = ${"number"}
              AND ${automaticApplicationRule(sql`s.id`)} IS NOT NULL
              AND EXISTS (SELECT 1 FROM "AuditLog" applied
                WHERE applied."entityKind" = s.entity AND applied."entityId" = t.id
                  AND s."acceptanceReceipt"->'auditIds' ? applied.id::text
                  AND applied.changes ? s.field
                  AND applied.changes->s.field->'to' = to_jsonb(t)->s.field)
              -- Automatic fill requires untouched fields. Every update must belong
              -- to this receipt; this also rejects ABA edits when timestamps tie.
              AND NOT EXISTS (SELECT 1 FROM "AuditLog" edited
                WHERE edited."entityKind" = s.entity AND edited."entityId" = t.id
                  AND edited.action = ${auditLogActionSchema.enum.update} AND edited.changes ? s.field
                  AND NOT (s."acceptanceReceipt"->'auditIds' ? edited.id::text))
              AND NOT EXISTS (SELECT 1 FROM "Feedback" member
                JOIN "AssessmentState" reviewed ON reviewed.id = member."assessmentId"
                WHERE reviewed.entity = s.entity AND reviewed."recordId" = s."recordId"
                  AND reviewed.family = ${assessmentFamily.enum.field} AND reviewed.field = s.field
                  AND member.authority = ${feedbackAuthority.enum.member} AND member.verdict IN (${feedbackVerdict.enum.correct}, ${feedbackVerdict.enum.wrong})
                  AND member."createdAt" >= (s."acceptanceReceipt"->>'acceptedAt')::timestamp)
          ), '{}'::jsonb) AS value
          FROM ${tableName} t
          WHERE t.id = ANY(${uuidArrayParam(ids)}) AND ${notDeleted(table)}
        `);
  return new Map(
    rows.rows.map((row) => [
      row.id,
      Object.fromEntries(
        Object.entries(currentOwnership.parse(row.value)).filter(([field]) => {
          const policy = entityFieldByKey(entity, field)?.control?.suggest;
          return policy?.mode === "fill" && !policy.reviewRequired;
        }),
      ),
    ]),
  );
}
