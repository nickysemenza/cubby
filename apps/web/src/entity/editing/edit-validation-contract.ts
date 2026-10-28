import { z } from "zod";

import {
  generatedEditableEntities,
  type EntityEditValidationInputs,
} from "~/entity/generated/entity-edit-validation-types.gen";

export const canonicalEditRequest = z.object({
  entity: z.enum(generatedEditableEntities),
  operation: z.enum(["create", "update", "bulkUpdate"]),
  value: z.unknown(),
});
export type CanonicalEditRequest = z.output<typeof canonicalEditRequest>;
export type CanonicalEditResult =
  | {
      ok: true;
      value: EntityEditValidationInputs[keyof EntityEditValidationInputs][
        | "create"
        | "update"
        | "bulkUpdate"];
    }
  | { ok: false; issues: { path: string[]; message: string }[] };
