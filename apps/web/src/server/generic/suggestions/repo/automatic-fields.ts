import { suggestionStatus, fieldSuggestionsInput } from "@cubby/schemas/ai";
/** Current field decisions backed by Automatic rule applications, never model confidence alone. */
import { auditLogActionSchema } from "@cubby/schemas/audit";
import type { Entity } from "@cubby/schemas/entity";
import {
  entityFieldByKey,
  entityFieldModels,
} from "@cubby/schemas/entity-fields";
import { fieldAssignmentOwnership } from "@cubby/schemas/field-envelope";
import {
  suggestionFamily,
  suggestionSubjects,
  feedbackAuthority,
  feedbackVerdict,
} from "@cubby/schemas/suggestion";
import { sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";

import { notDeleted } from "~/server/db/helpers/predicates";
import { uuidArrayParam } from "~/server/db/helpers/query";
import type { RepositoryQueryInput } from "~/server/db/repository-access.boundary";
import { repositoryQueries as unwrapDb } from "~/server/db/repository-access.boundary";
import { SHORTCODE_TABLE } from "~/server/generated/shortcode-tables.gen";
import type { CurrentFieldOwnership } from "~/server/generic/derived/repo/read-context";
import { automaticApplicationRule } from "~/server/generic/suggestions/repo/suggestion";
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
  projection?: readonly string[],
): Promise<Map<string, CurrentFieldOwnership>> {
  const eligibleEntity = fieldSuggestionsInput.shape.entity.safeParse(entity);
  if (!ids.length || !eligibleEntity.success) return new Map();
  const fields = entityFieldModels[entity].fields
    .filter(
      (field) =>
        field.control?.suggest?.mode === "fill" &&
        !field.control.suggest.reviewRequired &&
        (projection === undefined ||
          projection.includes(field.key) ||
          (field.readKey !== null && projection.includes(field.readKey))),
    )
    .map((field) => field.key);
  if (!fields.length) return new Map();
  const table = alias(SHORTCODE_TABLE[eligibleEntity.data], "t");
  const tableName = SHORTCODE_TABLE[eligibleEntity.data];
  const rows = await unwrapDb(db).execute<{
    id: string;
    value: unknown;
  }>(sql`
          SELECT t.id::text AS id, COALESCE((
            SELECT jsonb_object_agg(s.field, jsonb_build_object(${fieldAssignmentOwnership.options[1].keyof().enum.kind}::text, ${fieldAssignmentOwnership.options[1].shape.kind.value}::text, 'receiptId', s.id::text, 'confidence',
              (s."acceptanceReceipt"->>'confidence')::double precision))
            FROM "Suggestion" s
            WHERE s.entity = ${entity} AND s."recordId" = t.id
              AND s.field IN (${sql.join(
                fields.map((field) => sql`${field}`),
                sql`, `,
              )})
              AND s.family = ${suggestionFamily.enum.field} AND s.status = ${suggestionStatus.enum.applied}
              AND s.subject->>'entity' = s.entity AND s.subject->>${suggestionSubjects.field.keyof().enum.field} = s.field
              AND s.subject->>'recordId' = t.id::text
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
              AND NOT EXISTS (SELECT 1 FROM "Suggestion" reviewed
                CROSS JOIN LATERAL jsonb_to_recordset(reviewed.decisions) member(authority text, verdict text, "createdAt" text)
                WHERE reviewed.entity = s.entity AND reviewed."recordId" = s."recordId"
                  AND reviewed.family = ${suggestionFamily.enum.field} AND reviewed.field = s.field
                  AND member.authority = ${feedbackAuthority.enum.member} AND member.verdict IN (${feedbackVerdict.enum.correct}, ${feedbackVerdict.enum.wrong})
                  AND member."createdAt"::timestamptz >= (s."acceptanceReceipt"->>'acceptedAt')::timestamptz)
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
