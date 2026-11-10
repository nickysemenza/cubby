import { suggestionStatus } from "@cubby/schemas/ai";
import { entityFieldByKey } from "@cubby/schemas/entity-fields";
import {
  type ShortcodeEntity,
  shortcodeEntities,
} from "@cubby/schemas/entity-manifest";
import {
  feedbackAuthority,
  feedbackVerdict,
  suggestionFamily,
} from "@cubby/schemas/suggestion";
import { sql } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "~/server/db";
import { getDb } from "~/server/db/helpers";
import { SHORTCODE_TABLE } from "~/server/generated/shortcode-tables.gen";

const FIELD = suggestionFamily.enum.field;
const NAME = "name";
const shortcodeEntity = z.enum(shortcodeEntities);

/** Precedents one prompt carries. */
const PRECEDENT_LIMIT = 8;
const LINE_LIMIT = 200;

const precedentRow = z.object({
  label: z.string().nullable(),
  value: z.unknown(),
  valueLabel: z.string().nullable(),
  corrected: z.string().nullable(),
});

/**
 * Values a person set for this field on similar records: corrections of Cubby
 * first, then records sharing one of the field's reference-valued basis keys
 * (its parents, such as a Product's brand). Cubby's own unreviewed values are
 * never precedents, so one wrong automatic value cannot teach the next.
 */
export async function fieldPrecedents(
  db: Database,
  entity: ShortcodeEntity,
  field: string,
  recordId: string,
): Promise<string | null> {
  const model = entityFieldByKey(entity, field);
  const basis = model?.control?.suggest?.basis ?? [];
  const parents = basis.filter(
    (key) => entityFieldByKey(entity, key)?.reference,
  );
  if (!model || !parents.length) return null;
  const table = SHORTCODE_TABLE[entity];
  const referenced = shortcodeEntity.safeParse(model.reference?.entity).data;
  const referenceTable = referenced ? SHORTCODE_TABLE[referenced] : null;
  const valueLabel = referenceTable
    ? sql`(SELECT to_jsonb(r)->>${NAME} FROM ${referenceTable} r WHERE r.id::text = to_jsonb(t)->>${field})`
    : sql`NULL::text`;
  const sameParent = sql.join(
    parents.map(
      (key) =>
        sql`(to_jsonb(t)->${key} IS NOT NULL AND to_jsonb(t)->${key} = to_jsonb(subject)->${key})`,
    ),
    sql` OR `,
  );
  const rows = z.array(precedentRow).parse(
    (
      await getDb(db).execute<z.input<typeof precedentRow>>(sql`
        SELECT COALESCE(to_jsonb(t)->>${NAME}, to_jsonb(t)->>${"displayLabel"}) AS label,
          to_jsonb(t)->${field} AS value, ${valueLabel} AS "valueLabel",
          corrected.from_value AS corrected
        FROM ${table} subject
        JOIN ${table} t ON t.id <> subject.id AND (${sameParent})
        LEFT JOIN LATERAL (
          SELECT s."suggestedValue"::text AS from_value FROM "Suggestion" s
          WHERE s.family = ${FIELD} AND s.entity = ${entity}
            AND s."recordId" = t.id AND s.field = ${field}
            AND s.status = ${suggestionStatus.enum.rejected} AND s."correctValue" IS NOT NULL
          ORDER BY s."createdAt" DESC LIMIT 1
        ) corrected ON true
        WHERE subject.id = ${recordId}::uuid
          AND to_jsonb(t)->${field} IS NOT NULL
          AND to_jsonb(t)->>${field} <> ''
          AND to_jsonb(t)->>${"deletedAt"} IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM "Suggestion" held
            WHERE held.family = ${FIELD} AND held.entity = ${entity}
              AND held."recordId" = t.id AND held.field = ${field}
              AND held.status = ${suggestionStatus.enum.applied}
              AND held."acceptanceReceipt"->>'mode' = ${feedbackAuthority.enum.automatic}
              AND NOT EXISTS (
                SELECT 1 FROM jsonb_to_recordset(held.decisions)
                  member(authority text, verdict text)
                WHERE member.authority = ${feedbackAuthority.enum.member}
                  AND member.verdict = ${feedbackVerdict.enum.correct}
              )
          )
        ORDER BY (corrected.from_value IS NOT NULL) DESC,
          to_jsonb(t)->>'updatedAt' DESC NULLS LAST
        LIMIT ${PRECEDENT_LIMIT}
      `)
    ).rows,
  );
  if (!rows.length) return null;
  const lines = rows.map((row) => {
    const value =
      row.valueLabel ??
      (typeof row.value === "string" ? row.value : JSON.stringify(row.value));
    const line = `- ${row.label ?? "Unnamed record"} -> ${value}${row.corrected ? " (a person corrected Cubby here)" : ""}`;
    return line.slice(0, LINE_LIMIT);
  });
  return lines.join("\n");
}
