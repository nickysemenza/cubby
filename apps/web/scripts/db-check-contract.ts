export type DatabaseCheckConstraint = {
  name: string;
  definition: string;
  validated: boolean;
};

const sourceSlugDefinition =
  "CHECK (source ~ '^[a-z0-9]+(-[a-z0-9]+)*$'::text AND source = lower(TRIM(BOTH FROM source)))";

const mealAmountDefinition = `CHECK (amount IS NULL OR COALESCE(jsonb_typeof(amount) = 'object'::text AND amount ? 'value'::text AND amount ? 'unit'::text AND (amount - 'value'::text - 'unit'::text) = '{}'::jsonb AND
CASE
    WHEN jsonb_typeof(amount -> 'value'::text) = 'number'::text THEN ((amount ->> 'value'::text)::numeric) > 0::numeric AND ((amount ->> 'value'::text)::numeric) < 'Infinity'::numeric
    ELSE false
END AND jsonb_typeof(amount -> 'unit'::text) = 'string'::text AND length(TRIM(BOTH FROM amount ->> 'unit'::text)) > 0 AND (amount ->> 'unit'::text) = TRIM(BOTH FROM amount ->> 'unit'::text), false))`;

export const REQUIRED_DATABASE_CHECKS = [
  {
    name: "MealRecipePortion_amount_check",
    definition: mealAmountDefinition,
  },
  { name: "MealFoodEntry_amount_check", definition: mealAmountDefinition },
  {
    name: "ProductExternalId_source_slug_check",
    definition: sourceSlugDefinition,
  },
  {
    name: "ProductExternalId_gtin_digits_check",
    definition:
      "CHECK (source <> 'gtin'::text OR \"externalId\" ~ '^[0-9]{14}$'::text)",
  },
  {
    name: "StatementImport_source_slug_check",
    definition: sourceSlugDefinition,
  },
  { name: "StatementRow_source_slug_check", definition: sourceSlugDefinition },
  {
    name: "StatementRow_externalId_format_check",
    definition: "CHECK (\"externalId\" ~ '^v1:[0-9a-f]{64}$'::text)",
  },
  { name: "LedgerSourceClaim_source_check", definition: sourceSlugDefinition },
] as const;

const canonicalizeDefinition = (definition: string): string =>
  definition.replaceAll(/\s+/g, " ").trim();

export type CheckContractViolation =
  | { kind: "missing"; name: string }
  | { kind: "unexpected"; name: string }
  | { kind: "stale"; name: string; expected: string; actual: string }
  | { kind: "unvalidated"; name: string };

export const compareDatabaseChecks = (
  actual: readonly DatabaseCheckConstraint[],
): CheckContractViolation[] => {
  const expectedByName = new Map<string, string>(
    REQUIRED_DATABASE_CHECKS.map((check) => [check.name, check.definition]),
  );
  const actualByName = new Map(actual.map((check) => [check.name, check]));
  const violations: CheckContractViolation[] = [];
  for (const expected of REQUIRED_DATABASE_CHECKS) {
    const found = actualByName.get(expected.name);
    if (!found) {
      violations.push({ kind: "missing", name: expected.name });
      continue;
    }
    if (
      canonicalizeDefinition(found.definition) !==
      canonicalizeDefinition(expected.definition)
    ) {
      violations.push({
        kind: "stale",
        name: expected.name,
        expected: canonicalizeDefinition(expected.definition),
        actual: canonicalizeDefinition(found.definition),
      });
    }
    if (!found.validated) {
      violations.push({ kind: "unvalidated", name: expected.name });
    }
  }
  for (const found of actual) {
    if (!expectedByName.has(found.name)) {
      violations.push({ kind: "unexpected", name: found.name });
    }
  }
  return violations;
};
