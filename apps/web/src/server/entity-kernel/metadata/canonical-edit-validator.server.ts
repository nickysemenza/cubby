import { entityEditValidationLoaders } from "~/server/generated/entity-edit-validation.gen";

/** Canonical schemas retain required checks, transforms and cross-field refinements. */
export async function validateEntityEditInput(input: {
  entity: keyof typeof entityEditValidationLoaders;
  operation: "create" | "update" | "bulkUpdate";
  value: unknown;
}) {
  const schemas = await entityEditValidationLoaders[input.entity]();
  const schema = schemas[input.operation];
  if (!schema)
    throw new Error(`${input.entity} does not support ${input.operation}`);
  const result = schema.safeParse(input.value);
  return result.success
    ? { ok: true as const, value: result.data }
    : {
        ok: false as const,
        issues: result.error.issues.map(({ path, message }) => ({
          path: path.map(String),
          message,
        })),
      };
}
