import {
  entityFieldModels,
  type EntityFieldModel,
} from "@cubby/schemas/entity-fields";
import { getErrorMessage } from "@cubby/shared";
import { useMemo } from "react";

import { detailFieldRenderersFor } from "~/entity/detail-field-renderers";
import {
  entityMutationOptionsFactory,
  isGeneratedBrowserCrudEntity,
} from "~/entity/entity-contracts";
import {
  editableFieldOverrides,
  EntityBasicInfo,
  type DetailFieldRenderer,
} from "~/entity/entity-display";
import { savedWithBackgroundWork } from "~/lib/recompute-summary";
import { isReferencePickerEntity } from "~/ui/combobox/reference-picker-entities";
import { useEntityActionMutation } from "~/ui/hooks/useActionMutation";

import type { DetailRecordOf, GenericDetailEntity } from "./detail-record";

/** Scalar controls the generic inline editor renders as an `EditableCell`. */
const INLINE_EDITABLE_CONTROLS = new Set([
  "text",
  "textarea",
  "number",
  "date",
  "select",
  "checkbox",
]);

/**
 * The field keys of one `fields` section that the record's update contract
 * edits through a scalar control or a supported single-reference picker.
 * Structured and multiple-reference values use the complete editor.
 */
function inlineEditableKeys(
  entity: GenericDetailEntity,
  fields: readonly string[],
): string[] {
  if (!isGeneratedBrowserCrudEntity(entity)) return [];
  const model: EntityFieldModel = entityFieldModels[entity];
  const updateRoster: readonly string[] = model.update;
  const editable = new Set<string>(
    model.fields
      .filter(
        (field) =>
          updateRoster.includes(field.key) &&
          field.control !== null &&
          (field.reference === null
            ? INLINE_EDITABLE_CONTROLS.has(field.control.kind)
            : !field.reference.multiple &&
              isReferencePickerEntity(field.reference.entity)) &&
          field.readKey !== null,
      )
      .map((field) => field.key),
  );
  return fields.filter((key) => editable.has(key));
}

function useInlineFieldOverrides(
  entity: GenericDetailEntity,
  record: { id: string },
  fields: readonly string[],
): Record<string, DetailFieldRenderer<{ id: string }>> {
  const crud = isGeneratedBrowserCrudEntity(entity) ? entity : null;
  const mutation = useEntityActionMutation({
    // A non-CRUD entity (image, cookbook) never edits inline; the hook still
    // has to run unconditionally, so it binds to `product` and is never
    // invoked (the override set below is empty).
    entity: crud ?? "product",
    operation: "update",
    intent: "full",
    mutationFn: entityMutationOptionsFactory(crud ?? "product", "update"),
    success: (data) => savedWithBackgroundWork(data.sideEffects),
    error: (error) => getErrorMessage(error) || "Failed to save",
  });
  const keys = useMemo(
    () => inlineEditableKeys(entity, fields),
    [entity, fields],
  );
  if (crud === null || keys.length === 0) return {};
  // SAFETY: `keys` names fields of `crud`'s own update contract; the wire
  // variables are parsed by that contract before the mutation executes.
  return editableFieldOverrides(crud, record, keys, (variables) =>
    mutation.mutateAsync(variables as never),
  );
}

export function EntityRecordFields<E extends GenericDetailEntity>({
  entity,
  record,
  fields,
}: {
  entity: E;
  record: DetailRecordOf<E>;
  fields: readonly string[];
}) {
  const bag = record;
  const inline = useInlineFieldOverrides(entity, bag, fields);
  // A domain renderer for a structured field wins over the generic cell; the
  // inline editor covers the plain scalars a renderer never claims.
  const renderers = detailFieldRenderersFor(entity) ?? {};
  const overrides = { ...inline };
  for (const [key, render] of Object.entries(renderers)) {
    if (!fields.includes(key)) continue;
    // SAFETY: `detailFieldRenderersFor` hands back this entity's own
    // renderers, each typed against the record this page received.
    overrides[key] = () => render(record as never);
  }
  return (
    <EntityBasicInfo
      entity={entity}
      fields={fields}
      record={bag}
      overrides={overrides}
    />
  );
}
