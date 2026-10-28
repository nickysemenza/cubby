import type { Entity } from "@cubby/schemas/entity";
import type { EntityFieldModel } from "@cubby/schemas/entity-fields";
import type { QueryClient } from "@tanstack/react-query";

import { entityMetadata } from "~/entity/metadata";

export type EditMode = "create" | "edit";

export type EntityFieldPresentation = {
  key: string;
  label: string;
  description: string | null;
  provenance: EntityFieldModel["fields"][number]["provenance"];
  control: NonNullable<EntityFieldModel["fields"][number]["control"]>;
  editable: boolean;
};

/**
 * Presentation metadata for an editor field. Editability comes from the
 * generated create/update contract, never from storage or a guessed allowlist.
 */
export function entityFieldPresentation(
  queryClient: QueryClient,
  entity: Entity,
  fieldKey: string,
  mode: EditMode,
): EntityFieldPresentation {
  const model = entityMetadata(queryClient, entity).fields;
  const field = model.fields.find((candidate) => candidate.key === fieldKey);
  if (!field || !field.control) {
    throw new Error(`Field ${entity}.${fieldKey} has no editor control`);
  }

  const editable: readonly string[] =
    mode === "create" ? model.create : model.update;
  return {
    key: field.key,
    label: field.label,
    description: field.description,
    provenance: field.provenance,
    control: field.control,
    editable: editable.includes(field.key),
  };
}
