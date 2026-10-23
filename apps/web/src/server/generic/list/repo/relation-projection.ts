import type { Entity } from "@cubby/schemas/entity";
import type { GeneratedListField } from "@cubby/schemas/entity-list-fields";
import type { ShortcodeEntity } from "@cubby/schemas/entity-manifest";
import { sql } from "drizzle-orm";
import { z } from "zod";

import type { Database, DrizzleTransaction } from "~/server/db";
import { unwrapDb } from "~/server/db/helpers";
import {
  compileTraversal,
  tableFacts,
} from "~/server/generic/relatedness/repo/traversal";

const relationRows = z.array(
  z.object({ sourceId: z.string(), targetId: z.string() }),
);

/** A page batch follows the compiled live-target path; labels belong to the
 * canonical reference resolver, including targets with computed titles. */
export async function loadRelationProjection(
  db: Database | DrizzleTransaction,
  entity: Entity,
  field: Extract<GeneratedListField, { shape: "via" }>,
  target: ShortcodeEntity,
  ids: readonly string[],
): Promise<ReadonlyMap<string, string>> {
  if (field.many || field.terminal.kind !== "record")
    throw new Error(
      `List reference is not a to-one record: ${entity}.${field.path}`,
    );
  if (!ids.length) return new Map();
  const traversal = compileTraversal(entity, field.steps, "lp", { to: target });
  if (!tableFacts(traversal.leafTable).columns.has("id"))
    throw new Error(`List reference target has no identity: ${target}`);
  const root = sql.raw(traversal.rootAlias);
  const leaf = sql.raw(traversal.leafAlias);
  const result = await unwrapDb(db).execute(sql`
    SELECT ${root}."id" AS "sourceId", ${leaf}."id" AS "targetId"
    FROM ${sql.identifier(traversal.rootTable)} ${root} ${traversal.joins}
    WHERE ${root}."id" IN (${sql.join(
      ids.map((id) => sql`${id}`),
      sql`, `,
    )})
  `);
  return new Map(
    relationRows.parse(result.rows).map((row) => [row.sourceId, row.targetId]),
  );
}
