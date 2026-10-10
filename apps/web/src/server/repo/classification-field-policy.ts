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
