import { declaredClassificationPolicies } from "@cubby/schemas/classification-field-policy";
import { entityFieldModels } from "@cubby/schemas/entity-fields";
import { getTableColumns, getTableName } from "drizzle-orm";

import { SHORTCODE_TABLE } from "../repo/generated/shortcode-tables.gen";
import { entityIdentityTriggerSql } from "./entity-identity-schema";
import { entityLinkLivenessTriggerSql } from "./entity-link-schema";

const quoteIdentifier = (value: string) => `"${value.replaceAll('"', '""')}"`;
const quoteLiteral = (value: string) => `'${value.replaceAll("'", "''")}'`;

/** Any SQL writer that changes a stored backing column invalidates pending advice. */
const suggestionSupersedingTriggerSql = (): string => {
  const byTable = new Map<
    string,
    {
      tableName: string;
      columns: Array<{ entity: string; field: string; watched: string }>;
    }
  >();
  const referenced: Array<{
    tableName: string;
    entity: string;
    field: string;
    column: string;
    via: string;
    table: string;
  }> = [];
  for (const [entity, model] of Object.entries(entityFieldModels)) {
    // SAFETY: SHORTCODE_TABLE is generated from the same entity manifest and
    // this loop's key is one of its declared entity keys when present.
    const table = SHORTCODE_TABLE[entity as keyof typeof SHORTCODE_TABLE];
    if (!table) {
      for (const field of model.fields) {
        if (field.control?.suggest)
          throw new Error(
            `Suggest target ${entity}.${field.key} has no writable table or backedBy declaration.`,
          );
      }
      continue;
    }
    const tableName = getTableName(table);
    const columns = getTableColumns(table);
    for (const field of model.fields) {
      if (!field.control?.suggest) continue;
      const backedBy =
        "backedBy" in field.control.suggest
          ? field.control.suggest.backedBy
          : undefined;
      // SAFETY: the preceding key lookup is checked below before the column
      // is used; this assertion only adapts the manifest key to Drizzle's
      // column-key type.
      const column = columns[field.key as keyof typeof columns];
      if (!column) {
        if (!backedBy?.length)
          throw new Error(
            `Suggest target ${entity}.${field.key} has no physical column or backedBy declaration.`,
          );
      } else {
        const entry = byTable.get(tableName) ?? { tableName, columns: [] };
        entry.columns.push({
          entity,
          field: column.name,
          watched: column.name,
        });
        byTable.set(tableName, entry);
      }
      for (const backing of backedBy ?? []) {
        if ("entity" in backing) {
          const backingTable = Object.entries(SHORTCODE_TABLE).find(
            ([key]) => key === backing.entity,
          )?.[1];
          if (!backingTable)
            throw new Error(
              `Suggest target ${entity}.${field.key} backs through unknown entity ${backing.entity}.`,
            );
          referenced.push({
            tableName: getTableName(backingTable),
            table: tableName,
            entity,
            field: field.key,
            column: backing.column,
            via: backing.via,
          });
        } else {
          const entry = byTable.get(tableName) ?? { tableName, columns: [] };
          entry.columns.push({
            entity,
            field: field.key,
            watched: backing.column,
          });
          byTable.set(tableName, entry);
        }
      }
    }
  }
  const triggers = [...byTable.values()].map(({ tableName, columns }) => {
    const functionName = `${tableName}_supersede_suggestions_after_update`;
    const triggerName = `${tableName}_supersede_suggestions_after_update`;
    const body = columns
      .map(
        ({
          entity,
          field,
          watched,
        }) => `  IF OLD.${quoteIdentifier(watched)} IS DISTINCT FROM NEW.${quoteIdentifier(watched)} THEN
    UPDATE "Suggestion"
    SET "status" = 'superseded', "updatedAt" = now()
    WHERE "entity" = ${quoteLiteral(entity)}
      AND "recordId" = NEW."id"
      AND "field" = ${quoteLiteral(field)}
      AND "status" = 'pending';
  END IF;`,
      )
      .join("\n");
    const updatedColumns = [...new Set(columns.map(({ watched }) => watched))]
      .map(quoteIdentifier)
      .join(", ");
    return `CREATE OR REPLACE FUNCTION ${quoteIdentifier(functionName)}() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
${body}
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS ${quoteIdentifier(triggerName)} ON ${quoteIdentifier(tableName)};
CREATE TRIGGER ${quoteIdentifier(triggerName)} AFTER UPDATE OF ${updatedColumns} ON ${quoteIdentifier(tableName)} FOR EACH ROW EXECUTE FUNCTION ${quoteIdentifier(functionName)}();`;
  });
  const referencedTriggers = referenced.map(
    ({ tableName, table, entity, field, column, via }) => {
      const functionName = `${tableName}_supersede_${entity}_${field}_suggestions_after_update`;
      const triggerName = functionName;
      return `CREATE OR REPLACE FUNCTION ${quoteIdentifier(functionName)}() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.${quoteIdentifier(column)} IS DISTINCT FROM NEW.${quoteIdentifier(column)} THEN
    UPDATE "Suggestion" AS s SET "status" = 'superseded', "updatedAt" = now()
    FROM ${quoteIdentifier(table)} AS r
    WHERE s."entity" = ${quoteLiteral(entity)} AND s."field" = ${quoteLiteral(field)}
      AND s."status" = 'pending' AND r."id" = s."recordId" AND r.${quoteIdentifier(via)} = NEW."id";
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS ${quoteIdentifier(triggerName)} ON ${quoteIdentifier(tableName)};
CREATE TRIGGER ${quoteIdentifier(triggerName)} AFTER UPDATE OF ${quoteIdentifier(column)} ON ${quoteIdentifier(tableName)} FOR EACH ROW EXECUTE FUNCTION ${quoteIdentifier(functionName)}();`;
    },
  );
  return [...triggers, ...referencedTriggers].join("\n\n");
};

/**
 * One CHECK per field of an enforced same-record classification policy:
 * values whose policy is `not_allowed` require the field empty, and values
 * whose policy is `required` require it present. The constraint validates
 * existing rows, so a migration that meets a violator fails rather than
 * leaving a row that every later edit would reject.
 */
const classificationConstraintSql = (): string =>
  Object.values(declaredClassificationPolicies)
    .filter((policy) => policy.enforced)
    .flatMap((policy) => {
      const table = policy.owner[0]!.toUpperCase() + policy.owner.slice(1);
      const valuesWith = (
        fieldPolicy: (typeof policy.fields)[number],
        wanted: string,
      ) =>
        policy.values.filter(
          (value) =>
            // SAFETY: the generator keys `byValue` only by this classifier's
            // `values`; widening drops the literal key types, not entries.
            ((fieldPolicy.byValue as Record<string, string>)[value] ??
              fieldPolicy.otherwise) === wanted,
        );
      const inList = (values: readonly string[]) =>
        values.map((value) => `'${value}'`).join(", ");
      return policy.fields.flatMap((fieldPolicy) => {
        const clauses = [
          ["not_allowed", "IS NULL"],
          ["required", "IS NOT NULL"],
        ].flatMap(([policyValue, test]) => {
          const values = valuesWith(fieldPolicy, policyValue!);
          return values.length === 0
            ? []
            : [
                `("${policy.classifier}" NOT IN (${inList(values)}) OR "${fieldPolicy.field}" ${test})`,
              ];
        });
        if (clauses.length === 0) return [];
        const name = `${table}_classification_${policy.classifier}_${fieldPolicy.field}_check`;
        return [
          `ALTER TABLE "${table}" DROP CONSTRAINT IF EXISTS "${name}";\nALTER TABLE "${table}" ADD CONSTRAINT "${name}" CHECK (${clauses.join(" AND ")});`,
        ];
      });
    })
    .join("\n");

/**
 * DDL derived from the application model that drizzle-kit cannot express:
 * entity identity, EntityLink liveness and Suggestion superseding triggers,
 * plus classification constraints. Every statement is idempotent
 * (`CREATE OR REPLACE`, or drop-and-create where Postgres has no replace), so
 * `pnpm db:generate` can emit the whole script as a custom migration whenever
 * it changes and the result replays cleanly over any earlier version.
 * `drizzle/derived.lock` records the hash of the rendering the committed
 * migrations already contain.
 */
export function renderDerivedDdl(): string {
  return `${entityIdentityTriggerSql()}\n\n${entityLinkLivenessTriggerSql()}\n\n${suggestionSupersedingTriggerSql()}\n\n${classificationConstraintSql()}\n`;
}
