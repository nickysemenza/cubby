import type { ShortcodeEntity } from "@cubby/schemas/entity-manifest";
import { eq } from "drizzle-orm";

import type { RepositoryQueryInput } from "~/server/db/repository-access.boundary";
import { repositoryQueries } from "~/server/db/repository-access.boundary";
import { resolveLiveShortcode } from "~/server/generic/shortcode/repo/shortcode-resolver";

import type { EntityFieldsPlan, FieldsRow } from "./plan";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** The stored values of `columns` on one record, as the reconciler reads them, or null when it is gone. */
export async function readStoredColumns(
  db: RepositoryQueryInput,
  plan: EntityFieldsPlan,
  recordId: string,
  columns: readonly string[],
): Promise<FieldsRow | null> {
  const [row]: FieldsRow[] = await repositoryQueries(db)
    .select()
    .from(plan.table)
    .where(eq(plan.table.id, recordId));
  if (!row) return null;
  return Object.fromEntries(columns.map((key) => [key, row[key] ?? null]));
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
