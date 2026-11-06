import type { Entity } from "@cubby/schemas/entity";

import type {
  CanonicalEditRequest,
  CanonicalEditResult,
} from "~/entity/editing/edit-validation-contract";
import type { EntityMetadataSlice } from "~/entity/generated/entity-metadata-types.gen";
/** Annotated declarations keep server implementations outside the client checker.
 * The real handlers still demand-load and validate the canonical sources. */
export async function loadEntityMetadata(entity: Entity): Promise<{
  primary: EntityMetadataSlice;
  dependencies: EntityMetadataSlice[];
}> {
  const implementation = await import("./loader.server");
  return implementation.loadEntityMetadata(entity);
}
export async function validateEntityEditInput(
  input: CanonicalEditRequest,
): Promise<CanonicalEditResult> {
  const implementation = await import("./canonical-edit-validator.server");
  return implementation.validateEntityEditInput(input);
}
