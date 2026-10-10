import {
  type ClassifiedField,
  classificationReference,
  classificationValuesWhere,
  type DeclaredClassificationPolicyId,
  declaredPoliciesGoverning,
  declaredClassificationPolicies,
  type FieldPolicyValue,
  isFieldAllowed,
} from "@cubby/schemas/classification-field-policy";
import type { ShortcodeEntity } from "@cubby/schemas/entity-manifest";
import { parseEntityId } from "@cubby/schemas/identifiers";
import type { ProductCategoryFeature } from "@cubby/schemas/product-category-fields";
import { inArray, sql, type SQL } from "drizzle-orm";

import type { Database, DrizzleTransaction } from "~/server/db";
import { createAppError } from "~/server/errors/app-error";
import { categoryFeatureInSql } from "~/server/repo/product-category-sql";
import { resolveLiveShortcode } from "~/server/repo/shortcode-resolver";

type Db = Database | DrizzleTransaction;

/**
 * How each declared classification resolves its effective value — the typed
 * hook the generic evaluator cannot derive: ProductCategory `feature` is
 * inherited from the nearest bound ancestor (`productCategory.effective-feature`).
 */
type ClassificationSource = {
  owner: ShortcodeEntity;
  /** The effective value for one classifying record (a uuid). */
  resolve(db: Db, id: string): Promise<string | null>;
  /** SQL: the referenced record's effective value is one of `values`. */
  valueInSql(reference: SQL, values: readonly string[]): SQL<boolean>;
};

const classificationSources = {
  "productCategory.feature": {
    owner: "productCategory",
    // Late import: data-quality checks read this module, and the category
    // repository imports the list scaffold that loads those checks.
    resolve: async (db, id) => {
      const { getCategoryFeature } = await import("./product-category");
      return getCategoryFeature(db, parseEntityId("productCategory", id));
    },
    valueInSql: (reference, values) => {
      // SAFETY: generator validation restricts this source to productCategory.feature values.
      return categoryFeatureInSql(
        reference,
        values as ProductCategoryFeature[],
      );
    },
  },
} satisfies Partial<
  Record<DeclaredClassificationPolicyId, ClassificationSource>
>;
const classificationSource = (id: DeclaredClassificationPolicyId) =>
  id === "productCategory.feature"
    ? classificationSources["productCategory.feature"]
    : undefined;

/** SQL: the record's classification sets `policy` for `field`. */
export const classificationPolicySql = <
  Id extends DeclaredClassificationPolicyId,
>(
  id: Id,
  field: ClassifiedField<Id>,
  policy: FieldPolicyValue,
  reference: SQL,
): SQL<boolean> => {
  const values = classificationValuesWhere(id, field, policy);
  if (classificationReference(id) === null)
    return values.length
      ? sql<boolean>`${inArray(reference, values)}`
      : sql<boolean>`false`;
  const source = classificationSource(id);
  if (!source)
    throw new Error(`No classification source registered for ${id}.`);
  return source.valueInSql(reference, values);
};

/**
 * True when a recorded classification refuses `field` on this record.
 * `basis` holds the record's classification references as public shortcodes,
 * keyed by reference field (a Jev basis). A record without one is
 * unclassified: writing an evidence-bearing field classifies it
 * (`impliedClassification`), so nothing is refused yet. An unresolvable
 * shortcode counts as unclassified.
 */
export async function classificationRefusesField(
  db: Db,
  entity: string,
  field: string,
  basis: Readonly<Record<string, string | null | undefined>>,
): Promise<boolean> {
  for (const id of declaredPoliciesGoverning(entity, field)) {
    const referenceField = classificationReference(id);
    if (referenceField === null) {
      if (
        !isFieldAllowed(
          id,
          basis[declaredClassificationPolicies[id].classifier] ?? null,
          field,
        )
      )
        return true;
      continue;
    }
    const source = classificationSource(id);
    if (!source)
      throw new Error(`No classification source registered for ${id}.`);
    const shortcode = basis[referenceField];
    if (!shortcode) continue;
    const recordId = await resolveLiveShortcode(db, shortcode, source.owner);
    if (recordId === null) continue;
    if (!isFieldAllowed(id, await source.resolve(db, recordId), field))
      return true;
  }
  return false;
}

/** Enforce every same-record, database-enforced classification policy. */
export function assertClassificationPolicies(
  entity: string,
  // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- policy fields are manifest strings; this must read row[field] generically.
  row: Readonly<Record<string, unknown>>,
): void {
  for (const [id, policy] of Object.entries(declaredClassificationPolicies)) {
    if (
      !policy.enforced ||
      policy.target.entity !== entity ||
      policy.target.reference !== null
    )
      continue;
    const classifier = row[policy.classifier];
    for (const declaration of policy.fields) {
      const value = row[declaration.field];
      const status =
        (classifier === null || classifier === undefined
          ? undefined
          : Object.entries(declaration.byValue).find(
              ([value]) => value === String(classifier),
            )?.[1]) ?? declaration.otherwise;
      if (status === "not_allowed" && value !== null && value !== undefined) {
        throw createAppError(
          "CONSTRAINT_VIOLATION",
          ("refusal" in declaration ? declaration.refusal : undefined) ??
            `${String(classifier)} may not set ${declaration.field} (${id}).`,
        );
      }
      if (status === "required" && (value === null || value === undefined)) {
        throw createAppError(
          "CONSTRAINT_VIOLATION",
          `${String(classifier)} requires ${declaration.field} (${id}).`,
        );
      }
    }
  }
}

/** Fields currently set that become forbidden after a same-record reclassification. */
export function classificationFieldsToClear(
  entity: string,
  // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- source and target fields are manifest-declared strings.
  current: Readonly<Record<string, unknown>>,
  // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- source and target fields are manifest-declared strings.
  update: Readonly<Record<string, unknown>>,
): string[] {
  const clear = new Set<string>();
  for (const policy of Object.values(declaredClassificationPolicies)) {
    if (
      !policy.enforced ||
      policy.target.entity !== entity ||
      policy.target.reference !== null
    )
      continue;
    const classifier = update[policy.classifier] ?? current[policy.classifier];
    for (const declaration of policy.fields) {
      if (
        update[declaration.field] !== undefined ||
        current[declaration.field] == null
      )
        continue;
      const byValue: Readonly<Record<string, FieldPolicyValue>> =
        declaration.byValue;
      const status =
        (classifier == null ? undefined : byValue[String(classifier)]) ??
        declaration.otherwise;
      if (status === "not_allowed") clear.add(declaration.field);
    }
  }
  return [...clear];
}

/** Evaluate same-record declarations for a classifier basis. */
export function classificationAllowsField(
  entity: string,
  // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- classifier fields are manifest-declared strings.
  basis: Readonly<Record<string, unknown>>,
  field: string,
): boolean {
  return Object.values(declaredClassificationPolicies).every((policy) => {
    if (
      policy.target.entity !== entity ||
      policy.target.reference !== null ||
      !policy.fields.some((item) => item.field === field)
    )
      return true;
    const classifier = basis[policy.classifier];
    const declaration = policy.fields.find((item) => item.field === field)!;
    const byValue: Readonly<Record<string, FieldPolicyValue>> =
      declaration.byValue;
    return (
      ((classifier == null ? undefined : byValue[String(classifier)]) ??
        declaration.otherwise) !== "not_allowed"
    );
  });
}
