import {
  declaredClassificationPolicies,
  type FieldPolicyValue,
} from "@cubby/schemas/classification-field-policy";
import type { DataCheck } from "@cubby/schemas/data-quality";
import { getTableColumns, inArray, sql, type AnyColumn } from "drizzle-orm";

import type { CheckBinding, ScoredTable } from "../registry";

/** Build a scored check from one same-record classifier/field declaration. */
const classificationFieldCheck = <T extends ScoredTable>(
  classifier: AnyColumn,
  field: AnyColumn,
  requiredValues: readonly string[],
  refusedValues: readonly string[],
): CheckBinding<T> => {
  const present =
    field.dataType === "string"
      ? sql`(${field} IS NOT NULL AND trim(${field}::text) <> '')`
      : sql`${field} IS NOT NULL`;
  const empty =
    field.dataType === "string"
      ? sql`(${field} IS NULL OR trim(${field}::text) = '')`
      : sql`${field} IS NULL`;
  const applicable = [...requiredValues, ...refusedValues];
  return {
    expected: () =>
      applicable.length ? sql`${inArray(classifier, applicable)}` : sql`false`,
    missing: () => sql`(
      (${requiredValues.length ? inArray(classifier, requiredValues) : sql`false`}
        AND ${empty})
      OR (${refusedValues.length ? inArray(classifier, refusedValues) : sql`false`}
        AND ${present})
    )`,
  };
};

/** Checks keyed by the public gap ids declared on same-record policy fields. */
export const sameRecordClassificationChecks = <T extends ScoredTable>(
  entity: string,
  table: T,
): Array<readonly [DataCheck, CheckBinding<T>]> => {
  type Policy = {
    target: { entity: string; reference: string | null };
    classifier: string;
    values: readonly string[];
    fields: readonly {
      field: string;
      gap?: string;
      byValue: Readonly<Record<string, FieldPolicyValue>>;
      otherwise: FieldPolicyValue;
    }[];
  };
  const checks: Array<readonly [DataCheck, CheckBinding<T>]> = [];
  // SAFETY: this registry is generated from declarations and each entry has
  // the common shape validated by the entity generator.
  const policies = Object.values(declaredClassificationPolicies) as Policy[];
  const columns = Object.entries(getTableColumns(table));
  const column = (key: string) => columns.find(([name]) => name === key)?.[1];
  for (const policy of policies) {
    if (policy.target.entity !== entity || policy.target.reference !== null)
      continue;
    const classifier = column(policy.classifier);
    if (!classifier) continue;
    for (const declaration of policy.fields) {
      if (!declaration.gap) continue;
      const field = column(declaration.field);
      if (!field) continue;
      const requiredValues = policy.values.filter(
        (value) =>
          (declaration.byValue[value] ?? declaration.otherwise) === "required",
      );
      const refusedValues = policy.values.filter(
        (value) =>
          (declaration.byValue[value] ?? declaration.otherwise) ===
          "not_allowed",
      );
      // SAFETY: generator validation requires the gap to name a check in the
      // same entity's data-quality declaration.
      const check = declaration.gap as DataCheck;
      checks.push([
        check,
        classificationFieldCheck(
          classifier,
          field,
          requiredValues,
          refusedValues,
        ),
      ]);
    }
  }
  return checks;
};
