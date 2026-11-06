import type { Entity } from "@cubby/schemas/entity";
import {
  entityFieldModels,
  type EntityFieldModel,
} from "@cubby/schemas/entity-fields";
import {
  generatedEntityListFields,
  type GeneratedInherit,
} from "@cubby/schemas/entity-list-fields";
import { entityManifest } from "@cubby/schemas/entity-manifest";
import { fieldResolutionSourceSchema } from "@cubby/schemas/field-resolution";
import { sql, type SQL } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "~/server/db";
import {
  effectiveFieldSql,
  inheritanceLadderSql,
} from "~/server/db/computed/effective-field";
import { notDeleted, unwrapDb } from "~/server/db/helpers";
import {
  type Step,
  thisRecord,
} from "~/server/generic/field-explanation/repo/evidence-presentation";

const chainOf = (entity: Entity, field: string): GeneratedInherit | undefined =>
  Object.entries(generatedEntityListFields[entity].inherit).find(
    ([key]) => key === field,
  )?.[1];
const ref = (alias: string, column: string) =>
  sql`${sql.identifier(alias)}.${sql.identifier(column)}`;
const tableOf = (entity: Entity) => {
  const name = entityManifest[entity].dbTable;
  if (!name) throw new Error(`${entity} has no evidence table`);
  return sql.identifier(name);
};
const live = (entity: Entity, alias: string) =>
  entityManifest[entity].softDelete ? sql` AND ${notDeleted(alias)}` : sql``;
const node = z.object({
  shortcode: z.string(),
  name: z.string(),
  value: z.json(),
  assigned: z.boolean(),
  eligible: z.boolean(),
});

/** Walk the same ordered hierarchy and effective-reference sources used by resolution. */
export async function declaredInheritanceSteps(
  db: Database,
  entity: Entity,
  shortcode: string,
  field: string,
  sourceStart?: SQL,
) {
  const model: EntityFieldModel["fields"][number] | undefined =
    entityFieldModels[entity].fields.find(
      (candidate) => candidate.key === field,
    );
  const key = chainOf(entity, field)
    ? field
    : (model?.explanation?.evidence?.inheritField ?? model?.storedKey ?? field);
  const chain = chainOf(entity, key);
  if (!chain) return null;
  const steps: Step[] = [];
  const start =
    sourceStart ??
    sql`(SELECT id FROM ${tableOf(entity)} r WHERE r.shortcode=${shortcode}${live(entity, "r")})`;
  async function walk(
    kind: Entity,
    field: string,
    column: string,
    start: SQL,
    depth = 0,
  ): Promise<void> {
    if (depth > 10) throw new Error("Inheritance evidence path is recursive");
    const declaration = chainOf(kind, field);
    const target = declaration?.reference
      ? entityManifest[declaration.reference]
      : null;
    const raw =
      declaration?.from[0]?.kind === "hierarchy"
        ? sql`l.value`
        : ref("p", declaration?.column ?? column);
    const value = target?.dbTable
      ? sql`to_jsonb((SELECT c.shortcode FROM ${sql.identifier(target.dbTable)} c WHERE c.id=${raw}${target.softDelete ? sql` AND ${notDeleted("c")}` : sql``}))`
      : sql`to_jsonb(${raw})`;
    const shown = declaration?.mode?.none.length
      ? sql`jsonb_build_object(${"mode"}::text,${ref("p", declaration.mode.column)},${"category"}::text,${value})`
      : value;
    const ladder = declaration?.from[0]?.kind === "hierarchy";
    const result = await unwrapDb(db).execute(
      ladder
        ? sql`SELECT p.shortcode,p.name,${shown} AS value,l.decides AS assigned,l.eligible FROM ${inheritanceLadderSql(kind, field, start)} l JOIN ${tableOf(kind)} p ON p.id=l.id ORDER BY l.depth`
        : sql`SELECT p.shortcode,p.name,${shown} AS value,${raw} IS NOT NULL AS assigned,true AS eligible FROM ${tableOf(kind)} p WHERE p.id=${start}${live(kind, "p")}`,
    );
    for (const row of z.array(node).parse(result.rows)) {
      const self = kind === entity && row.shortcode === shortcode;
      steps.push({
        title: self ? thisRecord(entity) : row.name,
        ref: self
          ? null
          : {
              entityKind:
                fieldResolutionSourceSchema.shape.entityKind.parse(kind),
              entityId: row.shortcode,
            },
        value: row.value,
        assigned: row.assigned,
        self,
        ...(row.eligible
          ? {}
          : { unavailableReason: "Different effective source" }),
        ...(model?.resolution?.labels?.none
          ? { nullLabel: model.resolution.labels.none }
          : {}),
      });
    }
    for (const source of declaration?.from ?? []) {
      if (source.kind !== "effective") continue;
      let next = start;
      let current = kind;
      for (const hop of source.hops) {
        const value = chainOf(current, hop.field)
          ? effectiveFieldSql(current, hop.field, "r")
          : ref("r", hop.column);
        next = sql`(SELECT ${value} FROM ${tableOf(current)} r WHERE r.id=${next}${live(current, "r")})`;
        current = hop.target;
      }
      if (source.when)
        next = sql`(SELECT r.id FROM ${tableOf(current)} r WHERE r.id=${next} AND ${ref("r", source.when.column)}=${source.when.value}${live(current, "r")})`;
      await walk(current, source.field, source.column, next, depth + 1);
    }
  }
  await walk(entity, key, chain.column, start);
  const fallback = steps.find(
    (step) => !step.self && step.assigned && !step.unavailableReason,
  );
  return {
    steps,
    fallbackSource: fallback?.ref ? { ...fallback.ref, name: null } : null,
  };
}
