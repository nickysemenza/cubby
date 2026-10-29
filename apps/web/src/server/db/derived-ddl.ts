import { declaredClassificationPolicies } from "@cubby/schemas/classification-field-policy";

import { derivedTriggerDdl } from "~/server/db/derived-trigger-ddl";
import { entityIdentityDropTriggerSql } from "~/server/db/entity-identity-ddl";
import { entityLinkDropLivenessTriggerSql } from "~/server/db/entity-link-schema";

import { assessmentHistoryDdl, statementSuggestionDdl } from "./assessment-ddl";
import { productBrandDdl } from "./product-brand-ddl";
import { searchPrefixDdl } from "./search-prefix-ddl";

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
 * Desired-state DDL for the database catalog check beyond the Drizzle schema:
 * retired business triggers, assessment projection indexes and mail view,
 * plus classification constraints. db:check applies it only to its scratch
 * model database and compares that catalog with a migration-built database.
 * Changes require targeted SQL in an unmerged migration, not another copy of
 * this whole script.
 */
export function renderDerivedDdl(): string {
  return `${productBrandDdl()}\n\n${entityIdentityDropTriggerSql()}\n\n${entityLinkDropLivenessTriggerSql()}\n\n${classificationConstraintSql()}\n\n${assessmentHistoryDdl()}\n\n${statementSuggestionDdl()}\n\n${searchPrefixDdl()}\n\n${derivedTriggerDdl()}\n`;
}
