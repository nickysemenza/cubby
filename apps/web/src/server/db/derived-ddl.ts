import { declaredClassificationPolicies } from "@cubby/schemas/classification-field-policy";

import { entityIdentityTriggerSql } from "./entity-identity-schema";
import { entityLinkLivenessTriggerSql } from "./entity-link-schema";

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
 * the entity identity functions and triggers (ADR 0006) and the EntityLink
 * live-endpoint trigger (ADR 0007). Every statement is idempotent
 * (`CREATE OR REPLACE`, or drop-and-create where Postgres has no replace), so
 * `pnpm db:generate` can emit the whole script as a custom migration whenever
 * it changes and the result replays cleanly over any earlier version.
 * `drizzle/derived.lock` records the hash of the rendering the committed
 * migrations already contain.
 */
export function renderDerivedDdl(): string {
  return `${entityIdentityTriggerSql()}\n\n${entityLinkLivenessTriggerSql()}\n\n${classificationConstraintSql()}\n`;
}
