import { entityRefKey } from "@cubby/schemas/entity";
import { shortcodeEntities } from "@cubby/schemas/entity-manifest";
import { parseEntityRef } from "@cubby/schemas/identifiers";
import { suggestionRecordRef } from "@cubby/schemas/suggestion-list";
import { parseShortcode } from "@cubby/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "~/server/db";
import { unwrapDb, uuidArrayParam } from "~/server/db/helpers";
import { lookupShortcodes } from "~/server/generic/shortcode/repo/shortcode-resolver";
import { suggestionRecordsSql } from "~/server/generic/suggestions/repo/suggestion-work-tokens";

/** A typed entity plus UUID or shortcode; stored families predate a shared reference representation. */
const storedRef = z.object({
  entity: z.enum(shortcodeEntities),
  id: z.string().min(1),
});

export async function readSuggestionRecordRefs(
  db: Database,
  ids: readonly string[],
  entities?: readonly string[],
) {
  if (!ids.length)
    return new Map<string, z.infer<typeof suggestionRecordRef>[]>();
  const rows = await unwrapDb(db).execute<{
    id: string;
    refs: unknown;
  }>(
    sql`
    SELECT s.id, ${suggestionRecordsSql(entities)} AS refs FROM "Suggestion" s
    WHERE s.id = ANY(${uuidArrayParam(ids)})`,
    "objects",
  );
  return resolveStoredRecordRefs(db, rows);
}

/**
 * Pending counts per requested record, counted where the references are built.
 * A Suggestion counts once per record its declared references name, by UUID or
 * by shortcode, as `readSuggestionRecordRefs` would resolve them. Settlement
 * references repeat per allocation and line, so shipping every reference to
 * the Worker to count a page of badges exhausted its memory.
 */
export async function countSuggestionRecordRefs(
  db: Database,
  ids: readonly string[],
  records: readonly { entity: string; id: string; code: string }[],
) {
  if (!ids.length || !records.length) return new Map<string, number>();
  const rows = await unwrapDb(db).execute<{ code: string; pending: number }>(
    sql`
    WITH requested(entity, uuid, code) AS (VALUES ${sql.join(
      records.map(
        (record) =>
          sql`(${record.entity}::text, ${record.id}::text, ${record.code}::text)`,
      ),
      sql`, `,
    )})
    SELECT requested.code, count(DISTINCT s.id)::int AS pending
    FROM "Suggestion" s
    CROSS JOIN LATERAL jsonb_array_elements(${suggestionRecordsSql([
      ...new Set(records.map((record) => record.entity)),
    ])}) ref
    JOIN requested ON ref->>'entity' = requested.entity
      AND (ref->>'id' = requested.uuid OR upper(btrim(ref->>'id')) = requested.code)
    WHERE s.id = ANY(${uuidArrayParam(ids)})
    GROUP BY requested.code`,
    "objects",
  );
  return new Map(
    z
      .array(z.object({ code: z.string(), pending: z.number().int() }))
      .parse(rows)
      .map((row) => [row.code, row.pending]),
  );
}

export async function resolveStoredRecordRefs(
  db: Database,
  rows: readonly { id: string; refs: unknown }[],
) {
  const parsed = rows.map((row) => ({
    id: row.id,
    refs: z
      .array(z.unknown())
      .parse(row.refs)
      .flatMap((value) => {
        const result = storedRef.safeParse(value);
        return result.success ? [result.data] : [];
      }),
  }));
  const uuids = parsed.flatMap((row) =>
    row.refs
      .filter((value) => !parseShortcode(value.id))
      .flatMap((value) => {
        const uuid = z.uuid().safeParse(value.id);
        return uuid.success ? [parseEntityRef(value.entity, uuid.data)] : [];
      }),
  );
  const codes = await lookupShortcodes(db, uuids);
  return new Map(
    parsed.map((row) => {
      // First occurrence wins; a settlement graph repeats one record per line.
      const seen = new Set<string>();
      return [
        row.id,
        row.refs.flatMap((value) => {
          const code =
            parseShortcode(value.id)?.shortcode ??
            codes.get(entityRefKey(value.entity, value.id));
          const result = suggestionRecordRef.safeParse({
            entity: value.entity,
            id: code,
          });
          if (!result.success) return [];
          const key = entityRefKey(result.data.entity, result.data.id);
          if (seen.has(key)) return [];
          seen.add(key);
          return [result.data];
        }),
      ];
    }),
  );
}
