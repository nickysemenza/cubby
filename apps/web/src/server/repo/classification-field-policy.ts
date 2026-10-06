import {
  type ClassificationValue,
  type ClassifiedField,
  classificationReference,
  classificationValuesWhere,
  type DeclaredClassificationPolicyId,
  declaredPoliciesGoverning,
  type FieldPolicyValue,
  isFieldAllowed,
} from "@cubby/schemas/classification-field-policy";
import type { ShortcodeEntity } from "@cubby/schemas/entity-manifest";
import { parseEntityId } from "@cubby/schemas/identifiers";
import type { SQL } from "drizzle-orm";

import type { Database, DrizzleTransaction } from "~/server/db";
import { categoryFeatureInSql } from "~/server/repo/product-category-sql";
import { resolveLiveShortcode } from "~/server/repo/shortcode-resolver";

type Db = Database | DrizzleTransaction;

/**
 * How each declared classification resolves its effective value — the typed
 * hook the generic evaluator cannot derive: ProductCategory `feature` is
 * inherited from the nearest bound ancestor (`productCategory.effective-feature`).
 */
type ClassificationSource<Id extends DeclaredClassificationPolicyId> = {
  owner: ShortcodeEntity;
  /** The effective value for one classifying record (a uuid). */
  resolve(db: Db, id: string): Promise<ClassificationValue<Id> | null>;
  /** SQL: the referenced record's effective value is one of `values`. */
  valueInSql(reference: SQL, values: ClassificationValue<Id>[]): SQL<boolean>;
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
    valueInSql: categoryFeatureInSql,
  },
} satisfies {
  [Id in DeclaredClassificationPolicyId]: ClassificationSource<Id>;
};

/** SQL: the record's classification sets `policy` for `field`. */
export const classificationPolicySql = <
  Id extends DeclaredClassificationPolicyId,
>(
  id: Id,
  field: ClassifiedField<Id>,
  policy: FieldPolicyValue,
  reference: SQL,
): SQL<boolean> =>
  classificationSources[id].valueInSql(
    reference,
    classificationValuesWhere(id, field, policy),
  );

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
    const source = classificationSources[id];
    const shortcode = basis[classificationReference(id)];
    if (!shortcode) continue;
    const recordId = await resolveLiveShortcode(db, shortcode, source.owner);
    if (recordId === null) continue;
    if (!isFieldAllowed(id, await source.resolve(db, recordId), field))
      return true;
  }
  return false;
}
