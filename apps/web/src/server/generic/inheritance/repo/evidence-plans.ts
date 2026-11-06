import type { Entity } from "@cubby/schemas/entity";
import {
  entityFieldModels,
  type EntityFieldModel,
} from "@cubby/schemas/entity-fields";

/** The declaration selects executable evidence semantics, never an entity callback. */
export const fieldEvidencePlan = (entity: Entity, field: string) => {
  const model: EntityFieldModel["fields"][number] | undefined =
    entityFieldModels[entity].fields.find(
      (candidate) => candidate.key === field,
    );
  return model?.explanation?.evidence;
};
