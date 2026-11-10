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
) {
  if (!ids.length)
    return new Map<string, z.infer<typeof suggestionRecordRef>[]>();
  const rows = await unwrapDb(db).execute<{
    id: string;
    refs: unknown;
  }>(
    sql`
    SELECT s.id, ${suggestionRecordsSql()} AS refs FROM "Suggestion" s
    WHERE s.id = ANY(${uuidArrayParam(ids)})`,
    "objects",
  );
  return resolveStoredRecordRefs(db, rows);
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
