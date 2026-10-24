/**
 * The one registry and evaluator for classification-declared field policies:
 * whether a classification expects a field of the record it classifies, and
 * whether it allows one at all (`field-policy-fields.ts`). Data-quality gaps,
 * write admission, and decision suggestion targets all read these answers.
 *
 * Two storage shapes share it. A fixed classification declares its policy in
 * the entity manifest (`capabilities.classificationPolicies`, compiled to
 * `classification-field-policies.gen.ts`) keyed by the classifier's value. A
 * household-editable classification stores its policy per row, so the column
 * value *is* the policy (SpendingCategory `productExpectation`).
 */
import { fieldPolicyValue, type FieldPolicyValue } from "./field-policy-fields";
import { declaredClassificationPolicies } from "./generated/classification-field-policies.gen";
export { declaredClassificationPolicies } from "./generated/classification-field-policies.gen";

export type { FieldPolicyValue } from "./field-policy-fields";

type Declared = typeof declaredClassificationPolicies;
export type DeclaredClassificationPolicyId = keyof Declared;
export type ClassificationValue<Id extends DeclaredClassificationPolicyId> =
  Declared[Id]["values"][number];
export type ClassifiedField<Id extends DeclaredClassificationPolicyId> =
  Declared[Id]["fields"][number]["field"];

/** Per-row policy columns: the stored value is the field's policy. */
const columnClassificationPolicies = {
  "spendingCategory.productExpectation": {
    owner: "spendingCategory",
    column: "productExpectation",
    table: "SpendingCategory",
    target: { entity: "expense", field: "productId" },
  },
} as const;
export type ColumnClassificationPolicyId =
  keyof typeof columnClassificationPolicies;
type ColumnPolicyId = ColumnClassificationPolicyId;

export type ClassificationPolicyId =
  | DeclaredClassificationPolicyId
  | ColumnPolicyId;

export const columnClassificationPolicy = (id: ColumnPolicyId) =>
  columnClassificationPolicies[id];

const isColumnPolicy = (id: ClassificationPolicyId): id is ColumnPolicyId =>
  id in columnClassificationPolicies;

type FieldDeclaration = Readonly<{
  field: string;
  byValue: Readonly<Partial<Record<string, FieldPolicyValue>>>;
  otherwise: FieldPolicyValue;
  relation: boolean;
}>;

const declaredFields = (
  id: DeclaredClassificationPolicyId,
): readonly FieldDeclaration[] => declaredClassificationPolicies[id].fields;

/**
 * The policy a classification value sets for one field. `value` is the
 * effective classifier value (null when none resolves) for a declared
 * policy, or the stored policy itself for a column policy. A field the
 * classification does not govern is `unknown`.
 */
function fieldPolicy(
  id: ClassificationPolicyId,
  value: string | null,
  field: string,
): FieldPolicyValue {
  if (isColumnPolicy(id)) {
    if (columnClassificationPolicies[id].target.field !== field)
      return "unknown";
    return fieldPolicyValue.safeParse(value).data ?? "unknown";
  }
  const declaration = declaredFields(id).find((entry) => entry.field === field);
  if (!declaration) return "unknown";
  return (
    (value === null ? undefined : declaration.byValue[value]) ??
    declaration.otherwise
  );
}

export const isFieldAllowed = (
  id: ClassificationPolicyId,
  value: string | null,
  field: string,
): boolean => fieldPolicy(id, value, field) !== "not_allowed";

/** Classifier values (in option order) whose policy for `field` is `policy`. */
export const classificationValuesWhere = <
  Id extends DeclaredClassificationPolicyId,
>(
  id: Id,
  field: ClassifiedField<Id>,
  policy: FieldPolicyValue,
): ClassificationValue<Id>[] =>
  declaredClassificationPolicies[id].values.filter(
    (value) => fieldPolicy(id, value, field) === policy,
  );

/**
 * The classification a record's present fields imply: the one admitting value
 * of the first present field (declaration order) that is refused by default.
 * Declaration order is precedence — food evidence outranks an ISBN — so a
 * later field the implied classification also refuses is tolerated rather
 * than refused. Null when no present field implies a classification.
 */
export function impliedClassification<
  Id extends DeclaredClassificationPolicyId,
>(
  id: Id,
  present: ReadonlySet<ClassifiedField<Id>>,
): ClassificationValue<Id> | null {
  const presentFields: ReadonlySet<string> = present;
  for (const declaration of declaredFields(id)) {
    if (declaration.relation || declaration.otherwise !== "not_allowed")
      continue;
    if (!presentFields.has(declaration.field)) continue;
    // The generator proves exactly one admitting value per refused field.
    const admitting = declaredClassificationPolicies[id].values.find(
      (value) => fieldPolicy(id, value, declaration.field) !== "not_allowed",
    );
    if (admitting !== undefined) return admitting;
  }
  return null;
}

/** Declared policies classifying `entity` that govern `field`. */
export const declaredPoliciesGoverning = (
  entity: string,
  field: string,
): DeclaredClassificationPolicyId[] =>
  // SAFETY: the generated record is `as const`; its keys are exactly the ids.
  (
    Object.keys(
      declaredClassificationPolicies,
    ) as DeclaredClassificationPolicyId[]
  ).filter(
    (id) =>
      declaredClassificationPolicies[id].target.entity === entity &&
      declaredFields(id).some((entry) => entry.field === field),
  );

/** The classified entity's reference field, or null for same-record policy. */
export const classificationReference = (
  id: DeclaredClassificationPolicyId,
): string | null => declaredClassificationPolicies[id].target.reference;

/** Classifiers may be scalar fields or declared projections of a structured field. */
export function classificationValue<TRecord extends object>(
  policy: { readonly classifier: string; readonly readPath: string },
  record: TRecord,
): string | null {
  let value: unknown = record;
  for (const segment of policy.readPath.split(".")) {
    if (typeof value === "string") {
      try {
        value = JSON.parse(value);
      } catch {
        return null;
      }
    }
    if (value === null || typeof value !== "object") return null;
    value = Object.entries(value).find(([key]) => key === segment)?.[1];
  }
  return typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
    ? String(value)
    : null;
}

/** A refused same-record field has no editor or suggestion action on any client. */
export function classificationFieldRefusal<TRecord extends object>(
  entity: string,
  record: TRecord,
  field: string,
): string | null {
  for (const policy of Object.values(declaredClassificationPolicies)) {
    if (policy.target.entity !== entity || policy.target.reference !== null)
      continue;
    const declaration = policy.fields.find((item) => item.field === field);
    if (!declaration) continue;
    const classifier = classificationValue(policy, record);
    const byValue: Readonly<Record<string, FieldPolicyValue>> =
      declaration.byValue;
    if (
      ((classifier === null ? undefined : byValue[classifier]) ??
        declaration.otherwise) === "not_allowed"
    )
      return "refusal" in declaration && typeof declaration.refusal === "string"
        ? declaration.refusal
        : "This field does not apply to this record.";
  }
  return null;
}

export function classificationFieldDependencies(
  entity: string,
  field: string,
): string[] {
  return Object.values(declaredClassificationPolicies).flatMap((policy) =>
    policy.target.entity === entity &&
    policy.target.reference === null &&
    policy.fields.some((item) => item.field === field)
      ? [policy.readPath.split(".")[0] ?? policy.classifier]
      : [],
  );
}
