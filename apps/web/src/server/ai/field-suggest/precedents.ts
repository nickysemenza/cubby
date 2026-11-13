import { entityFieldByKey } from "@cubby/schemas/entity-fields";
import {
  type ShortcodeEntity,
  shortcodeEntities,
} from "@cubby/schemas/entity-manifest";
import { getTableColumns, sql } from "drizzle-orm";
import { z } from "zod";

import {
  correctedSql,
  PRECEDENT_LIMIT,
  personHoldsSql,
  precedentLines,
} from "~/server/ai/fields/repo/precedents";
import type { Database } from "~/server/db";
import { getDb } from "~/server/db/helpers";
import { SHORTCODE_TABLE } from "~/server/generated/shortcode-tables.gen";

const NAME = "name";
const shortcodeEntity = z.enum(shortcodeEntities);

const precedentRow = z.object({
  label: z.string().nullable(),
  value: z.json(),
  valueLabel: z.string().nullable(),
  corrected: z.boolean(),
});

/**
 * A saved record's precedent lines for an in-line question (an edit form's
 * saved record); the `fields` scope loads the same precedents through its
 * keyed reads. Records sharing one of the field's reference-valued basis
 * keys (its parents, such as a Product's brand) supply them.
 */
export async function fieldPrecedents(
  db: Database,
  entity: ShortcodeEntity,
  field: string,
  recordId: string,
): Promise<string | null> {
  const model = entityFieldByKey(entity, field);
  const basis = model?.control?.suggest?.basis ?? [];
  const table = SHORTCODE_TABLE[entity];
  const columns = getTableColumns(table);
  // Parents are reference-valued basis keys stored as real columns, so the
  // sibling join uses their indexes.
  const parents = basis.flatMap((key) => {
    const column = Object.entries(columns).find(([name]) => name === key)?.[1];
    return entityFieldByKey(entity, key)?.reference && column
      ? [column.name]
      : [];
  });
  if (!model || !parents.length) return null;
  const referenced = shortcodeEntity.safeParse(model.reference?.entity).data;
  const referenceTable = referenced ? SHORTCODE_TABLE[referenced] : null;
  const valueLabel = referenceTable
    ? sql`(SELECT to_jsonb(r)->>${NAME} FROM ${referenceTable} r WHERE r.id::text = to_jsonb(t)->>${field})`
    : sql`NULL::text`;
  const sameParent = sql.join(
    parents.map(
      (column) =>
        sql`t.${sql.identifier(column)} = subject.${sql.identifier(column)}`,
    ),
    sql` OR `,
  );
  const corrected = correctedSql(entity, field, sql`t.id`);
  const rows = z.array(precedentRow).parse(
    (
      await getDb(db).execute<z.input<typeof precedentRow>>(sql`
        SELECT COALESCE(to_jsonb(t)->>${NAME}, to_jsonb(t)->>${"displayLabel"}) AS label,
          to_jsonb(t)->${field} AS value, ${valueLabel} AS "valueLabel",
          ${corrected} AS corrected
        FROM ${table} subject
        JOIN ${table} t ON t.id <> subject.id AND (${sameParent})
        WHERE subject.id = ${recordId}::uuid
          AND to_jsonb(t)->${field} IS NOT NULL
          AND to_jsonb(t)->>${field} <> ''
          AND to_jsonb(t)->>${"deletedAt"} IS NULL
          AND ${personHoldsSql(entity, field, sql`t.id`)}
        ORDER BY ${corrected} DESC, to_jsonb(t)->>'updatedAt' DESC NULLS LAST
        LIMIT ${PRECEDENT_LIMIT}
      `)
    ).rows,
  );
  const labels = new Map(
    rows.flatMap((row) =>
      row.valueLabel && typeof row.value === "string"
        ? [[row.value, row.valueLabel] as const]
        : [],
    ),
  );
  return precedentLines(rows, labels);
}
