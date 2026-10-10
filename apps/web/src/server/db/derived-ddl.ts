import { declaredClassificationPolicies } from "@cubby/schemas/classification-field-policy";

import { entityIdentityTriggerSql } from "./entity-identity-schema";
import { entityLinkLivenessTriggerSql } from "./entity-link-schema";

const classificationConstraintSql = (): string => {
  const statements: string[] = [];
  for (const policy of Object.values(declaredClassificationPolicies)) {
    if (policy.target.reference !== null || policy.owner === "gardenEntry")
      continue;
    const table = policy.owner[0]!.toUpperCase() + policy.owner.slice(1);
    for (const fieldPolicy of policy.fields) {
      const refused = Object.entries(fieldPolicy.byValue)
        .filter(([, value]) => value === "not_allowed")
        .map(([value]) => value);
      const allowed = Object.entries(fieldPolicy.byValue)
        .filter(([, value]) => value !== "not_allowed")
        .map(([value]) => value);
      const deniedValues =
        fieldPolicy.otherwise === "not_allowed" ? allowed : refused;
      const required = Object.entries(fieldPolicy.byValue)
        .filter(([, value]) => value === "required")
        .map(([value]) => value);
      const clauses = [
        ...(deniedValues.length
          ? [
              `"${policy.classifier}" NOT IN (${deniedValues.map((v) => `'${v}'`).join(", ")}) OR "${fieldPolicy.field}" IS NULL`,
            ]
          : []),
        ...(required.length
          ? [
              `"${policy.classifier}" NOT IN (${required.map((v) => `'${v}'`).join(", ")}) OR "${fieldPolicy.field}" IS NOT NULL`,
            ]
          : []),
      ];
      if (!clauses.length) continue;
      const name = `${table}_classification_${policy.classifier}_${fieldPolicy.field}_check`;
      statements.push(
        `ALTER TABLE "${table}" DROP CONSTRAINT IF EXISTS "${name}";\nALTER TABLE "${table}" ADD CONSTRAINT "${name}" CHECK (${clauses.join(" AND ")}) NOT VALID;`,
      );
    }
  }
  return statements.join("\n");
};

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
