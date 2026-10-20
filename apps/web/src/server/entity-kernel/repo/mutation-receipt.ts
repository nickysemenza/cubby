import {
  entityFieldModels,
  type EntityFieldModel,
} from "@cubby/schemas/entity-fields";
import type { ShortcodeEntity } from "@cubby/schemas/entity-manifest";
import type { entityMutationItem } from "@cubby/schemas/entity-mutation";
import { getTableColumns, sql, type SQL } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "~/server/db";
import { getDb } from "~/server/db/helpers";
import { SHORTCODE_TABLE } from "~/server/generated/shortcode-tables.gen";

import { nonColumnMutationScalar } from "./mutation-scalar";

const valuesSchema = z.record(z.string(), z.json());
const rowSchema = z.object({
  id: z.string(),
  values: valuesSchema,
});
const tables = new Map(Object.entries(SHORTCODE_TABLE));

/** Only submitted scalar columns and point-reference identities cross the write boundary. */
export async function readMutationReceiptFields(
  db: Database,
  entity: ShortcodeEntity,
  entityId: string,
  requested: readonly string[],
  options: {
    includeStoredCollections?: boolean;
  } = {},
) {
  const table = SHORTCODE_TABLE[entity];
  const columns = Object.values(getTableColumns(table));
  const model: EntityFieldModel = entityFieldModels[entity];
  const selected: {
    key: string;
    value: SQL;
  }[] = [];
  for (const key of new Set(requested)) {
    const field = model.fields.find((field) => field.key === key);
    const stored = model.storage.find((column) => column.key === key);
    const column = columns.find((column) => column.name === stored?.column);
    if (!field || (field.collection && !options.includeStoredCollections))
      continue;
    const adapted = nonColumnMutationScalar(entity, key);
    const own =
      adapted ??
      (column
        ? sql`${sql.identifier("saved")}.${sql.identifier(column.name)}`
        : undefined);
    if (!own) continue;
    const target =
      !adapted && field.reference && !field.reference.multiple
        ? tables.get(field.reference.entity)
        : undefined;
    const value = target
      ? sql`(SELECT ref.shortcode FROM ${target} ref WHERE ref.id=${own})`
      : own;
    selected.push({ key, value });
  }
  const entries = selected.flatMap(({ key, value }) => [
    sql`${key}::text`,
    value,
  ]);
  const result = await getDb(db).execute(sql`SELECT saved.shortcode AS id,
    jsonb_build_object(${sql.join(entries, sql`, `)}) AS values
    FROM ${table} saved WHERE saved.id=${entityId}::uuid AND saved."deletedAt" IS NULL LIMIT 1`);
  const [row] = z.array(rowSchema).parse(result.rows);
  if (!row) throw new Error(`Saved ${entity} is no longer live: ${entityId}`);
  const item: z.infer<typeof entityMutationItem> = {
    id: row.id,
    ...row.values,
  };
  return { item };
}
