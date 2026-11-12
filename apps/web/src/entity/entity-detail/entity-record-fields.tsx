import { classificationFieldRefusal } from "@cubby/schemas/classification-field-policy";
import type { EntityFieldModel } from "@cubby/schemas/entity-fields";
import { fieldDecisionOf } from "@cubby/schemas/field-envelope";
import { getErrorMessage } from "@cubby/shared";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useMemo } from "react";

import { detailFieldRenderersFor } from "~/entity/display/detail-field-renderers";
import {
  editableFieldOverrides,
  EntityBasicInfo,
  type DetailFieldRenderer,
} from "~/entity/display/entity-display";
import {
  entityMutationOptionsFactory,
  isGeneratedBrowserCrudEntity,
} from "~/entity/entity-contracts";
import { fieldResolutionFor } from "~/entity/fields/field-resolution";
import { useEntityActionMutation } from "~/entity/hooks/use-action-mutation";
import { entityMetadata, useEntityMetadata } from "~/entity/metadata";
import { savedWithBackgroundWork } from "~/lib/recompute-summary";
import { isReferencePickerEntity } from "~/ui/combobox/reference-picker-entities";
import { FoldedFacts } from "~/ui/records/facts";

import { readPathValue } from "../read-path";
import type { DetailRecordOf, GenericDetailEntity } from "./detail-record";
import { fieldQualityChecks, useFieldQuality } from "./record-quality";

type Field = EntityFieldModel["fields"][number];

/** Scalar controls the generic inline editor renders as an `EditableCell`. */
const INLINE_EDITABLE_CONTROLS = new Set([
  "text",
  "textarea",
  "number",
  "date",
  "dateRange",
  "select",
  "checkbox",
]);

/**
 * The field keys of one `fields` section that the record's update contract
 * edits through a scalar control or a supported single-reference picker.
 * Structured and multiple-reference values use the complete editor.
 */
function inlineEditableKeys(
  queryClient: QueryClient,
  entity: GenericDetailEntity,
  fields: readonly string[],
): string[] {
  if (!isGeneratedBrowserCrudEntity(entity)) return [];
  const model: EntityFieldModel = entityMetadata(queryClient, entity).fields;
  const updateRoster: readonly string[] = model.update;
  const editable = new Set<string>(
    model.fields
      .filter(
        (field) =>
          // A summary cell may name a field hidden from detail; it stays
          // read-only there.
          field.display.detail &&
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
  const queryClient = useQueryClient();
  useEntityMetadata(entity);
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
    () => inlineEditableKeys(queryClient, entity, fields),
    [queryClient, entity, fields],
  );
  if (crud === null || keys.length === 0) return {};
  // SAFETY: `keys` names fields of `crud`'s own update contract; the wire
  // variables are parsed by that contract before the mutation executes.
  return editableFieldOverrides(queryClient, crud, record, keys, (variables) =>
    mutation.mutateAsync(variables as never),
  );
}

const hasValue = (value: unknown) =>
  value != null &&
  value !== "" &&
  !(Array.isArray(value) && value.length === 0);

/**
 * Whether a field has a value worth showing. A refused classification and an
 * allocated decision keep their named state; a field with no flat read is
 * drawn by its renderer and always counts. A list field reads its display
 * items.
 */
export function fieldRecorded<E extends GenericDetailEntity>(
  entity: E,
  record: DetailRecordOf<E>,
  field: Field,
): boolean {
  const resolution = fieldResolutionFor(record, field.key);
  if (
    (resolution ? fieldDecisionOf(resolution)?.provenance?.kind : undefined) ===
      "allocated" ||
    classificationFieldRefusal(entity, record, field.key) !== null
  )
    return true;
  if (field.display.itemsPath)
    return hasValue(readPathValue(record, field.display.itemsPath));
  return (
    field.readKey === null ||
    hasValue(readPathValue(record, field.display.readPath ?? field.readKey))
  );
}

/**
 * The renderer each named field shows on a detail surface, shared by field
 * sections and summary cells so a fact keeps its interaction wherever it is
 * placed.
 */
export function useDetailFieldOverrides<E extends GenericDetailEntity>(
  entity: E,
  record: DetailRecordOf<E>,
  fields: readonly string[],
) {
  const queryClient = useQueryClient();
  const inline = useInlineFieldOverrides(entity, record, fields);
  // A domain renderer for a structured field wins over the generic cell; the
  // inline editor covers the plain scalars a renderer never claims.
  const renderers = detailFieldRenderersFor(queryClient, entity) ?? {};
  const overrides = { ...inline };
  for (const [key, render] of Object.entries(renderers)) {
    if (!fields.includes(key)) continue;
    // SAFETY: `detailFieldRenderersFor` hands back this entity's own
    // renderers, each typed against the record this page received.
    overrides[key] = () => render(record as never, queryClient);
  }
  return overrides;
}

/**
 * A field section: recorded facts as rows, and the absent ones folded into one
 * "N fields not recorded" line whose body keeps their Add controls. A field
 * with a quality check, or one its record requires, stays a visible row.
 */
export function EntityRecordFields<E extends GenericDetailEntity>({
  entity,
  record,
  fields,
  sectionTitle,
}: {
  entity: E;
  record: DetailRecordOf<E>;
  fields: readonly string[];
  /** The heading above: a lone prose field needn't say its name twice. */
  sectionTitle?: string;
}) {
  const queryClient = useQueryClient();
  const overrides = useDetailFieldOverrides(entity, record, fields);
  const quality = useFieldQuality(entity, record.id);
  const model: readonly Field[] = entityMetadata(queryClient, entity).fields
    .fields;
  const folded = fields.flatMap((key) => {
    const field = model.find((candidate) => candidate.key === key);
    if (
      !field ||
      fieldRecorded(entity, record, field) ||
      field.requiredOnCreate ||
      fieldQualityChecks(quality?.checks ?? [], key).length > 0
    )
      return [];
    return [field];
  });
  const foldedKeys = new Set(folded.map((field) => field.key));
  const shown = fields.filter((key) => !foldedKeys.has(key));
  const pick = (keys: readonly string[]) =>
    Object.fromEntries(
      Object.entries(overrides).filter(([key]) => keys.includes(key)),
    );
  return (
    <div className="grid min-w-0 gap-1">
      {shown.length > 0 ? (
        <EntityBasicInfo
          entity={entity}
          fields={shown}
          record={record}
          overrides={pick(shown)}
          sectionTitle={sectionTitle}
        />
      ) : null}
      <FoldedFacts labels={folded.map((field) => field.label)}>
        <EntityBasicInfo
          entity={entity}
          fields={[...foldedKeys]}
          record={record}
          overrides={pick([...foldedKeys])}
        />
      </FoldedFacts>
    </div>
  );
}
