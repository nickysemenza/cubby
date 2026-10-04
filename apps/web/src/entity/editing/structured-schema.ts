import type { StructuredValueSchema } from "@cubby/schemas/structured-value-schema";
import { structuredValueSchemas } from "@cubby/schemas/structured-value-schemas";

/** The generated schema the generic structured-value editor draws for `entity.field`, if any. */
export const structuredSchemaFor = (
  entity: string,
  field: string,
): StructuredValueSchema | undefined =>
  Object.entries(structuredValueSchemas).find(
    ([key]) => key === `${entity}.${field}`,
  )?.[1];
