import { createIsomorphicFn, createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { type EntityEditValidationInputs } from "~/entity/generated/entity-edit-validation-types.gen";

import { canonicalEditRequest } from "./edit-validation-contract";
import type {
  EntityEditCreateInput,
  EntityEditUpdateInput,
  TypedEditableEntity,
} from "./intent-types";

export type UnparsedEntityEditData = Parameters<z.ZodType["parse"]>[0];
export type EntityEditBulkUpdateInput<E extends TypedEditableEntity> =
  EntityEditValidationInputs[E]["bulkUpdate"];

// Reflected bulk collection keys have an erased static type; their original
// item schemas still validate them before this function returns.
const validateCanonicalEdit = createServerFn({
  method: "POST",
  strict: { output: false },
})
  .validator(canonicalEditRequest)
  .handler(async ({ data }) => {
    const { validateEntityEditInput } =
      await import("~/server/entity-metadata/read.boundary");
    return validateEntityEditInput(data);
  });

const validateEdit = createIsomorphicFn()
  .server(async (data: z.output<typeof canonicalEditRequest>) => {
    const { validateEntityEditInput } =
      await import("~/server/entity-metadata/read.boundary");
    return validateEntityEditInput(data);
  })
  .client((data) => validateCanonicalEdit({ data }));

async function parseCanonicalEdit(
  entity: TypedEditableEntity,
  operation: "create" | "update" | "bulkUpdate",
  value: UnparsedEntityEditData,
) {
  const result = await validateEdit({ entity, operation, value });
  if (!result.ok) {
    // Start serializes issues as data; restore the existing field-error boundary.
    throw new z.ZodError(
      result.issues.map((issue) => ({ ...issue, code: "custom" })),
    );
  }
  return result.value;
}

export function parseEntityEditCreateInput<E extends TypedEditableEntity>(
  entity: E,
  value: UnparsedEntityEditData,
): Promise<EntityEditCreateInput<E>>;
export async function parseEntityEditCreateInput(
  entity: TypedEditableEntity,
  value: UnparsedEntityEditData,
) {
  return parseCanonicalEdit(entity, "create", value);
}

export function parseEntityEditUpdateInput<E extends TypedEditableEntity>(
  entity: E,
  value: UnparsedEntityEditData,
): Promise<EntityEditUpdateInput<E>>;
export async function parseEntityEditUpdateInput(
  entity: TypedEditableEntity,
  value: UnparsedEntityEditData,
) {
  return parseCanonicalEdit(entity, "update", value);
}

export function parseEntityEditBulkUpdateInput<E extends TypedEditableEntity>(
  entity: E,
  value: UnparsedEntityEditData,
): Promise<EntityEditBulkUpdateInput<E>>;
export async function parseEntityEditBulkUpdateInput(
  entity: TypedEditableEntity,
  value: UnparsedEntityEditData,
) {
  return parseCanonicalEdit(entity, "bulkUpdate", value);
}
