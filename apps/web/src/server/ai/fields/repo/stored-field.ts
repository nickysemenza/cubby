import type { ShortcodeEntity } from "@cubby/schemas/entity-manifest";
import { inArray } from "drizzle-orm";

import type { RepositoryQueryInput } from "~/server/db/repository-access.boundary";
import { repositoryQueries } from "~/server/db/repository-access.boundary";
import { resolveLiveShortcode } from "~/server/generic/shortcode/repo/shortcode-resolver";

import type { EntityFieldsPlan, FieldsRow } from "./plan";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** Stored basis columns by record id; absent records stay absent. */
export async function readStoredRows(
  db: RepositoryQueryInput,
  plan: EntityFieldsPlan,
  recordIds: readonly string[],
  columns: readonly string[],
): Promise<ReadonlyMap<string, FieldsRow>> {
  if (!recordIds.length) return new Map();
  const rows: FieldsRow[] = await repositoryQueries(db)
    .select()
    .from(plan.table)
    .where(inArray(plan.table.id, [...recordIds]));
  return new Map(
    rows.map((row) => [
      String(row.id),
      Object.fromEntries(columns.map((key) => [key, row[key] ?? null])),
    ]),
  );
}

/** A reference answer as its column stores it: the id behind a shortcode. */
export async function storedReferenceId(
  db: RepositoryQueryInput,
  entity: ShortcodeEntity,
  value: string,
): Promise<string> {
  if (UUID.test(value)) return value;
  const id = await resolveLiveShortcode(db, value, entity);
  if (!id)
    throw new Error(`Cubby answered ${value}, which is not a live ${entity}`);
  return id;
}
