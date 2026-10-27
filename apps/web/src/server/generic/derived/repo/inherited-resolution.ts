/** Live inheritance reads share the declaration compiler with filtering and explanations. */
import type { Entity } from "@cubby/schemas/entity";
import { entityFieldByKey } from "@cubby/schemas/entity-fields";
import {
  generatedEntityListFields,
  type GeneratedInherit,
} from "@cubby/schemas/entity-list-fields";
import { entitySummary } from "@cubby/schemas/entity-summary";
import { fieldEmptyReason } from "@cubby/schemas/field-envelope";
import {
  fieldResolutionsSchema,
  fieldResolutionSchema,
  fieldResolutionSourceSchema,
} from "@cubby/schemas/field-resolution";
import { type SQL, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import {
  effectiveFieldSql,
  inheritedFieldDecisionSchema,
  inheritedFieldDecisionSql,
  inheritedOwnAssignmentSql,
} from "~/server/db/computed/effective-field";
import { notDeleted } from "~/server/db/helpers/predicates";
import { sqlEnumConstant } from "~/server/db/sql-enum";
import { SHORTCODE_TABLE } from "~/server/generated/shortcode-tables.gen";
import { labelSql } from "~/server/generic/entity-graph/repo/record-label";

const resolutionKeys = fieldResolutionSchema.keyof().enum;
const sourceKeys = fieldResolutionSourceSchema.keyof().enum;
const decision = inheritedFieldDecisionSchema.options[0];
const decisionKeys = decision.keyof().enum;
const mode = fieldResolutionSchema.shape.mode;

const referenceTable = (entity: Entity) => {
  const table = Object.entries(SHORTCODE_TABLE).find(
    ([key]) => key === entity,
  )?.[1];
  if (!table) throw new Error(`${entity} has no reference table`);
  return { table: alias(table, "r"), from: sql`${table} r` };
};

const column = (alias: string, key: string) =>
  sql`${sql.identifier(alias)}.${sql.identifier(key)}`;
const chainOf = (entity: Entity, field: string): GeneratedInherit | undefined =>
  Object.entries(generatedEntityListFields[entity].inherit).find(
    ([key]) => key === field,
  )?.[1];

/** Terminal identities can cross several effective-reference hops. */
function sourceEntities(
  entity: Entity,
  chain: GeneratedInherit,
  visited = new Set<string>(),
): Entity[] {
  return [
    ...new Set(
      chain.from.flatMap((source): Entity[] => {
        if (source.kind === "hierarchy") return [entity];
        const target = source.hops.at(-1)?.target;
        if (!target) throw new Error(`${entity} inherits through no path`);
        const key = `${target}.${source.field}`;
        const nested = chainOf(target, source.field);
        if (!nested || visited.has(key)) return [target];
        return [
          target,
          ...sourceEntities(target, nested, new Set([...visited, key])),
        ];
      }),
    ),
  ];
}

/** Public references use live shortcodes; scalar enum values retain their declared value. */
function publicValue(chain: GeneratedInherit, value: SQL): SQL {
  if (chain.reference === null) return value;
  const { table, from } = referenceTable(chain.reference);
  const code = (id: SQL) =>
    sql`(SELECT ${table.shortcode} FROM ${from} WHERE ${table.id}::text = ${id} AND ${notDeleted(table)})`;
  if (chain.empty === "array")
    return sql`(SELECT COALESCE(jsonb_agg(${code(sql`item.id`)} ORDER BY item.position), '[]'::jsonb) FROM jsonb_array_elements_text(${value}) WITH ORDINALITY item(id, position))`;
  return sql`to_jsonb(${code(sql`${value} #>> '{}'`)})`;
}

function resolutionSql(
  entity: Entity,
  field: string,
  chain: GeneratedInherit,
  alias: string,
): SQL {
  const model = entityFieldByKey(entity, field);
  if (!model?.resolution)
    throw new Error(`${entity}.${field} has no resolution model`);
  const own = inheritedOwnAssignmentSql(entity, field, alias);
  const source = sql`facts.fallback->${decisionKeys.source}`;
  const sourceId = sql`${source}->>${sourceKeys.entityId}`;
  const sourceKind = sql`${source}->>${sourceKeys.entityKind}`;
  const identities = sourceEntities(entity, chain).map((target) => {
    const { table, from } = referenceTable(target);
    return sql`WHEN ${sourceKind} = ${target} THEN (SELECT jsonb_build_object(${sourceKeys.entityKind}::text, ${target}::text, ${sourceKeys.entityId}::text, ${table.shortcode}, ${sourceKeys.name}::text, ${labelSql(target, "r")}) FROM ${from} WHERE ${table.id}::text = ${sourceId} AND ${notDeleted(table)})`;
  });
  const hierarchy = chain.from.find((item) => item.kind === "hierarchy");
  const sourceLabel = sql`CASE ${sql.join(
    sourceEntities(entity, chain).map((target) => {
      const label = entitySummary[target].singular;
      return sql`WHEN ${sourceKind} = ${target} THEN ${
        target === entity && hierarchy
          ? sql`CASE WHEN ${sourceId} = ${column(alias, hierarchy.parentColumn)}::text THEN ${`Parent ${label.toLowerCase()}`} ELSE ${`Ancestor ${label.toLowerCase()}`} END`
          : sql`${`${label} default`}`
      }`;
    }),
    sql` `,
  )} ELSE ${chain.reference === null ? `No ${model.label.toLowerCase()} source` : "Unassigned"} END`;
  const stored = publicValue(chain, sql`facts.stored`);
  const value = publicValue(chain, sql`facts.value`);
  const fallback = publicValue(
    chain,
    sql`facts.fallback->${decisionKeys.value}`,
  );
  return sql`(SELECT jsonb_build_object(
    ${resolutionKeys.mode}::text, CASE WHEN facts.explicit THEN CASE WHEN facts.stored IS NULL OR facts.stored = 'null'::jsonb THEN ${sqlEnumConstant(mode, mode.enum.none)} ELSE ${sqlEnumConstant(mode, mode.enum.explicit)} END ELSE ${sqlEnumConstant(mode, mode.enum.inherit)} END,
    ${resolutionKeys.storedValue}::text, ${stored}, ${resolutionKeys.value}::text, ${value}, ${resolutionKeys.fallbackValue}::text, ${fallback},
    ${resolutionKeys.source}::text, CASE WHEN facts.explicit THEN ${`${entitySummary[entity].singular} override`} ELSE ${sourceLabel} END,
    ${resolutionKeys.sourceEntity}::text, CASE WHEN facts.explicit THEN NULL ELSE CASE ${sql.join(identities, sql` `)} END END,
    ${resolutionKeys.matchesFallback}::text, facts.explicit AND facts.stored IS NOT NULL AND facts.stored <> 'null'::jsonb AND COALESCE(facts.stored = facts.fallback->${decisionKeys.value}, false),
    ${resolutionKeys.canReset}::text, facts.explicit AND ${model.resolution.none ? sql`true` : sql`facts.fallback->>${decisionKeys.kind} = ${decision.shape.kind.value}`}
  ) || CASE WHEN NOT facts.explicit AND facts.fallback->>'reason' IN (${sqlEnumConstant(fieldEmptyReason, fieldEmptyReason.enum.explicit_none)}, ${sqlEnumConstant(fieldEmptyReason, fieldEmptyReason.enum.not_applicable)})
    THEN jsonb_build_object(${resolutionKeys.emptyReason}::text, facts.fallback->>'reason') ELSE '{}'::jsonb END
  FROM (SELECT ${own.explicit} AS explicit, to_jsonb(${own.value}) AS stored,
    to_jsonb(${effectiveFieldSql(entity, field, alias)}) AS value,
    ${inheritedFieldDecisionSql(entity, field, alias)} AS fallback) facts)`;
}

/** No per-entity roster: every declared inherited field participates. */
export function inheritedFieldResolutionsSql(entity: Entity, alias: string) {
  const entries = Object.entries(generatedEntityListFields[entity].inherit);
  return sql`jsonb_build_object(${sql.join(
    entries.flatMap(([field, chain]) => [
      sql`${field}::text`,
      resolutionSql(entity, field, chain, alias),
    ]),
    sql`, `,
  )})`.mapWith((value: unknown) => fieldResolutionsSchema.parse(value));
}
