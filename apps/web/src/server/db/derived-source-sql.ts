import { storedFieldDecision } from "@cubby/schemas/derived-value";
import type { Entity } from "@cubby/schemas/entity";
import { sql, type SQL } from "drizzle-orm";

import {
  storedDerived,
  type EntityStoredDerivedDeclaration,
} from "~/server/db/derived-declarations";

/** A declared typed snapshot projects the same read contract without another value store. */
export function storedSourceSql(
  declaration: EntityStoredDerivedDeclaration,
  id: SQL,
): SQL {
  const source = declaration.snapshotSource;
  if (!source)
    return sql`SELECT v.value, v."decidedBy", v."computedAt", v."sortNumber", v."sortText", v."sortDate" FROM "DerivedValue" v
    WHERE v."entityId" = ${id} AND v.kind = ${declaration.entity} AND v.key = ${declaration.key}`;
  const value =
    typeof source.value === "string"
      ? sql`COALESCE(to_jsonb(q.${sql.identifier(source.value)}), 'null'::jsonb)`
      : sql`jsonb_build_object(${sql.join(
          Object.entries(source.value).flatMap(([key, column]) => [
            sql`${key}::text`,
            sql`q.${sql.identifier(column)}`,
          ]),
          sql`, `,
        )})`;
  const decision = source.decidedBy
    ? sql`q.${sql.identifier(source.decidedBy)}`
    : sql`CASE WHEN ${value} IS NULL THEN
      ${JSON.stringify(storedFieldDecision.parse({ outcome: { kind: "empty", reason: "unset" }, provenance: { kind: "computed" } }))}::jsonb
      ELSE ${JSON.stringify(storedFieldDecision.parse({ outcome: { kind: "value" }, provenance: { kind: "computed" } }))}::jsonb END`;
  return sql`SELECT ${value} AS value, ${decision} AS "decidedBy", q.${sql.identifier(source.computedAt)} AS "computedAt",
    ${source.sort && declaration.sort === "number" ? sql`q.${sql.identifier(source.sort)}` : sql`NULL::double precision`} AS "sortNumber",
    ${source.sort && declaration.sort === "text" ? sql`q.${sql.identifier(source.sort)}` : sql`NULL::text`} AS "sortText",
    ${source.sort && declaration.sort === "date" ? sql`q.${sql.identifier(source.sort)}` : sql`NULL::timestamp`} AS "sortDate"
    FROM ${sql.identifier(source.table)} q WHERE q."entityId" = ${id} AND q.kind = ${declaration.entity} AND q.${sql.identifier(source.computedAt)} IS NOT NULL`;
}

/** Domain SQL reads name a manifest result rather than its current storage owner. */
export function declaredStoredSourceSql(
  entity: Entity,
  key: string,
  id: SQL,
): SQL {
  const declaration = storedDerived(entity, key);
  if (!declaration)
    throw new Error(`Undeclared stored result: ${entity}.${key}`);
  return storedSourceSql(declaration, id);
}
