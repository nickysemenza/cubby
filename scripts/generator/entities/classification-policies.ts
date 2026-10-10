import { generatedHeader } from "../artifacts.ts";
import {
  EntityDeclarationError,
  type CompiledEntity,
  type EntityArtifacts,
} from "./declarations.ts";

type DeclaredPolicy = CompiledEntity["classificationPolicies"][number];

const classifierValues = (
  owner: CompiledEntity,
  policy: DeclaredPolicy,
  context: string,
): readonly string[] => {
  const field = owner.fieldModel.fields.find(
    (candidate) => candidate.key === policy.classifier,
  );
  const options = field?.control?.options ?? null;
  if (options === null || options.length === 0)
    throw new EntityDeclarationError(
      `${context}.classifier ${policy.classifier} must be an enum field of ${owner.key} with select options.`,
    );
  return options.map((option) => option.value);
};

const assertEnforcedIsSameRecord = (
  policy: DeclaredPolicy,
  context: string,
) => {
  if (policy.enforced && policy.target !== undefined)
    throw new EntityDeclarationError(
      `${context}.enforced applies only to same-record policies; a referenced classification cannot be a row CHECK.`,
    );
};

const assertGapIsValid = (
  policy: DeclaredPolicy,
  field: DeclaredPolicy["fields"][number],
  context: string,
  seen: Set<string>,
): void => {
  if (!field.gap) return;
  if (policy.target !== undefined)
    throw new EntityDeclarationError(
      `${context}.gap applies only to same-record policies.`,
    );
  if (seen.has(field.gap))
    throw new EntityDeclarationError(
      `${context}.gap ${field.gap} is duplicated.`,
    );
  seen.add(field.gap);
  const outcomes = [...Object.values(field.byValue), field.otherwise];
  if (outcomes.includes("required") === outcomes.includes("not_allowed"))
    throw new EntityDeclarationError(
      `${context}.gap needs required or not_allowed outcomes, but not both.`,
    );
};

/**
 * Cross-entity checks for `capabilities.classificationPolicies`: the
 * classifier is an enum on the owner, the target references the owner, every
 * policy field exists on the target, every `byValue` key is a classifier
 * value, and a field refused by default has exactly one admitting value — the
 * classification its evidence implies (`impliedClassification`).
 */
export const validateClassificationPolicies = (
  entities: readonly CompiledEntity[],
): void => {
  const byKey = new Map(entities.map((entity) => [entity.key, entity]));
  for (const owner of entities) {
    const seenGaps = new Set<string>();
    for (const [index, policy] of owner.classificationPolicies.entries()) {
      const context = `${owner.key}.capabilities.classificationPolicies[${index}]`;
      const values = classifierValues(owner, policy, context);
      const targetEntity = policy.target?.entity ?? owner.key;
      const target = byKey.get(targetEntity);
      if (target === undefined)
        throw new EntityDeclarationError(
          `${context}.target names undeclared entity ${targetEntity}.`,
        );
      const reference =
        policy.target?.reference === undefined
          ? null
          : target.fieldModel.fields.find(
              (field) => field.key === policy.target?.reference,
            );
      if (
        policy.target?.reference !== undefined &&
        reference?.reference?.entity !== owner.key
      )
        throw new EntityDeclarationError(
          `${context}.target.reference ${policy.target.reference} must be a ${target.key} field referencing ${owner.key}.`,
        );
      assertEnforcedIsSameRecord(policy, context);
      const seen = new Set<string>();
      for (const fieldPolicy of policy.fields) {
        const fieldContext = `${context}.fields.${fieldPolicy.field}`;
        if (seen.has(fieldPolicy.field))
          throw new EntityDeclarationError(`${fieldContext} is duplicated.`);
        seen.add(fieldPolicy.field);
        if (!target.fieldModel.fields.some((f) => f.key === fieldPolicy.field))
          throw new EntityDeclarationError(
            `${fieldContext} is not a field of ${target.key}.`,
          );
        for (const value of Object.keys(fieldPolicy.byValue)) {
          if (!values.includes(value))
            throw new EntityDeclarationError(
              `${fieldContext}.byValue: ${value} is not a ${policy.classifier} value.`,
            );
        }
        assertGapIsValid(policy, fieldPolicy, fieldContext, seenGaps);
        if (fieldPolicy.otherwise !== "not_allowed") continue;
        const admitting = Object.entries(fieldPolicy.byValue).filter(
          ([, value]) => value !== "not_allowed",
        );
        if (admitting.length !== 1)
          throw new EntityDeclarationError(
            `${fieldContext} is refused by default, so it needs exactly one admitting value (found ${admitting.length}).`,
          );
      }
    }
  }
};

/**
 * `classification-field-policies.gen.ts`: every declared policy keyed
 * `<owner>.<classifier>`, with the classifier's values in option order.
 * `@cubby/schemas/classification-field-policy` registers these beside the
 * per-row policy columns and evaluates both.
 */
export const renderClassificationPolicyArtifacts = (
  entities: readonly CompiledEntity[],
): EntityArtifacts[] => {
  const entries = entities.flatMap((owner) =>
    owner.classificationPolicies.map((policy, index) => {
      const values = classifierValues(
        owner,
        policy,
        `${owner.key}.capabilities.classificationPolicies[${index}]`,
      );
      return `  ${JSON.stringify(`${owner.key}.${policy.classifier}`)}: ${JSON.stringify(
        {
          owner: owner.key,
          classifier: policy.classifier,
          values,
          target: policy.target
            ? { ...policy.target }
            : { entity: owner.key, reference: null },
          enforced: policy.enforced,
          fields: policy.fields,
        },
      )},`;
    }),
  );
  const source =
    generatedHeader +
    'import type { FieldPolicyValue } from "../field-policy-fields";\n\n' +
    "type DeclaredClassificationPolicy = Readonly<{\n" +
    "  owner: string;\n" +
    "  classifier: string;\n" +
    "  values: readonly string[];\n" +
    "  target: Readonly<{ entity: string; reference: string | null }>;\n" +
    "  enforced: boolean;\n" +
    "  fields: readonly Readonly<{\n" +
    "    field: string;\n" +
    "    byValue: Readonly<Record<string, FieldPolicyValue>>;\n" +
    "    otherwise: FieldPolicyValue;\n" +
    "    refusal?: string;\n" +
    "    gap?: string;\n" +
    "  }>[];\n" +
    "}>;\n\n" +
    `export const declaredClassificationPolicies = {\n${entries.join("\n")}\n} as const satisfies Record<string, DeclaredClassificationPolicy>;\n`;
  return [
    {
      relativePath:
        "packages/schemas/src/generated/classification-field-policies.gen.ts",
      source,
    },
  ];
};
