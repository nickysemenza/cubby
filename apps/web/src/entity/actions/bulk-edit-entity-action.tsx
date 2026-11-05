import type { Entity } from "@cubby/schemas/entity";
import { type ShortcodeEntity } from "@cubby/schemas/entity-manifest";
import { canClearExpenseDate } from "@cubby/schemas/expense-fields";
import type { StructuredValueSchema } from "@cubby/schemas/structured-value-schema";
import { countLabel } from "@cubby/shared/pluralize";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo, useRef, useState } from "react";
import {
  FormProvider,
  useForm,
  type FieldValues,
  type UseFormReturn,
} from "react-hook-form";
import { z } from "zod";

import {
  renderIntentField,
  type PrimitiveFieldModel,
  type SearchProviderFor,
} from "~/entity/editing/entity-primitive-fields";
import { fieldClearing } from "~/entity/editing/field-clearing";
import { presentEntitySelectOptions } from "~/entity/editing/select-options";
import { structuredSchemaFor } from "~/entity/editing/structured-schema";
import { wireValue } from "~/entity/editing/structured-value";
import { StructuredValueField } from "~/entity/editing/structured-value-field";
import { entityLabel } from "~/entity/entities";
import { bulkUpdateMutationOptionsFactory } from "~/entity/entity-contracts";
import { PickerField } from "~/entity/forms/picker-field";
import { generatedBulkEditEntities } from "~/entity/generated/entity-edit-validation-types.gen";
import { ensureEntityMetadata, useEntityMetadata } from "~/entity/metadata";
import { requireReferenceEntitySearch } from "~/entity/picker/reference-entity-search";
import { fieldSuggestionBasisFromRecord } from "~/entity/suggestions/field-suggestion";
import { FieldSuggestionProvider } from "~/entity/suggestions/field-suggestion-provider";
import { suggestTargetsFor } from "~/entity/suggestions/suggestion-targets";
import { BulkActionDialog } from "~/ui/dialogs/bulk-action-dialog";
import { showErrorToast } from "~/ui/feedback/error-details";
import { AliasesField } from "~/ui/forms/aliases-field";
import { Row } from "~/ui/layout";
import { Button } from "~/ui/primitives/button";

import { useActionMutation } from "../hooks/use-action-mutation";
import { VerbMenuItem } from "./action-verb-ui";
import type { ActionVerbId } from "./action-verbs";
import type { EntityActionHandles, EntityActionRow } from "./entity-actions";

/** The same compiler-derived normal-update roster served by MCP. */
export const bulkEditEntities: readonly ShortcodeEntity[] =
  generatedBulkEditEntities;

/**
 * What a bulk-edit form field actually produces: select and reference
 * controls write a string (a select's value, or a picker's shortcode/`""`
 * for "cleared"); checkbox writes a boolean. Explicit modes distinguish an
 * untouched empty control from a requested clear.
 */
type BulkEditFieldValue = z.infer<ReturnType<typeof z.json>>;
type BulkFieldMode = "unchanged" | "set" | "clear";

const collectionIdentity = (
  field: PrimitiveFieldModel,
): "value" | readonly string[] | undefined =>
  "collection" in field ? field.collection?.key : undefined;
const isBulkCollection = (field: PrimitiveFieldModel | undefined) =>
  field !== undefined &&
  (collectionIdentity(field) !== undefined ||
    field.reference?.multiple === true);

const collectionRemoveSchema = (
  schema: StructuredValueSchema,
  identity: "value" | readonly string[] | undefined,
): StructuredValueSchema => {
  if (
    identity === undefined ||
    identity === "value" ||
    !("array" in schema.node) ||
    !("object" in schema.node.array.item.node)
  )
    return schema;
  const item = schema.node.array.item;
  return {
    ...schema,
    node: {
      array: {
        ...schema.node.array,
        item: {
          ...item,
          node: {
            object: {
              ...schema.node.array.item.node.object,
              fields: schema.node.array.item.node.object.fields.filter(
                (field) => identity.includes(field.key),
              ),
            },
          },
        },
      },
    },
  };
};

/** The submit payload: the derived bulk field roster keys the dirty subset. */
export type BulkEditDraft = Record<string, BulkEditFieldValue>;

/**
 * A row's passthrough value — list columns (`status`, `trade`, `projectId`)
 * read dynamically by the effect preview below, plus `EntityActionRow`'s own
 * optional numeric fields (`subtaskCount`, `recipeCount`). Not narrowed
 * further: the row shape differs per entity, and this hook is generic over
 * all of them.
 */
type BulkEditRowValue = string | number | boolean | null | undefined;

interface BulkEditRow extends EntityActionRow {
  name: string;
  [key: string]: BulkEditRowValue;
}

const asBulkEditRow = (row: EntityActionRow): BulkEditRow => ({
  ...row,
  name: row.name || row.id,
});

/**
 * Renders the derived bulk field roster in roster order. Each field's
 * control comes from `renderIntentField`, the record editor's own dispatcher;
 * this wrapper adds only the unchanged/set/clear assignment modes.
 */
function BulkEditFields({
  entity,
  fieldKeys,
  form,
  searchProviderFor = requireReferenceEntitySearch,
  modes,
  onModeChange,
  clearCost,
}: {
  entity: Entity;
  fieldKeys: readonly string[];
  form: UseFormReturn<FieldValues>;
  searchProviderFor?: SearchProviderFor;
  modes: Readonly<Record<string, BulkFieldMode>>;
  onModeChange: (field: PrimitiveFieldModel, mode: BulkFieldMode) => void;
  clearCost: number | null;
}) {
  const queryClient = useQueryClient();
  const model = useEntityMetadata(entity).fields;
  const assignment = { clearCost, searchProviderFor };
  return (
    <>
      {fieldKeys.map((key) => {
        const field = model.fields.find((candidate) => candidate.key === key);
        if (!field) {
          throw new Error(
            `Bulk-edit field ${entity}.${key} is not declared on the entity's field model.`,
          );
        }
        // Resolution controls write their mode fields alongside the visible value.
        if (!field.control) {
          const companion = model.fields.some(
            (owner) =>
              owner.key !== field.key &&
              [
                ...Object.keys(owner.resolution?.reset ?? {}),
                ...Object.keys(owner.resolution?.none ?? {}),
              ].includes(field.key),
          );
          if (companion) return null;
          throw new Error(
            `Bulk-edit field ${entity}.${key} has no normal editor control.`,
          );
        }
        const structured = structuredSchemaFor(queryClient, entity, key);
        const structuredList =
          structured &&
          "array" in structured.node &&
          !("text" in structured.node.array.item.node)
            ? structured
            : undefined;
        const clearing = fieldClearing(
          entity,
          field.key,
          field.nullable,
          clearCost,
        );
        const mode =
          modes[key] ?? (form.formState.dirtyFields[key] ? "set" : "unchanged");
        return (
          <fieldset key={field.key} aria-label={`${field.label} assignment`}>
            <fieldset className="mb-2" aria-label={`${field.label} change`}>
              <Row gap="xs" wrap>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  aria-pressed={mode === "unchanged"}
                  onClick={() => onModeChange(field, "unchanged")}
                >
                  Leave unchanged
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  aria-pressed={mode === "set"}
                  onClick={() => onModeChange(field, "set")}
                >
                  Set value
                </Button>
                {field.nullable && !isBulkCollection(field) ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    aria-pressed={mode === "clear"}
                    disabled={!clearing.clearable}
                    title={clearing.clearDisabledReason}
                    onClick={() => onModeChange(field, "clear")}
                  >
                    {clearing.clearLabel}
                  </Button>
                ) : null}
              </Row>
            </fieldset>
            {clearing.clearDisabledReason ? (
              <p className="text-xs text-muted-foreground">
                {clearing.clearDisabledReason}
              </p>
            ) : null}
            <fieldset disabled={mode === "clear"}>
              {isBulkCollection(field) ? (
                <>
                  {(["add", "remove"] as const).map((operation) =>
                    field.reference?.multiple ? (
                      <PickerField
                        key={operation}
                        store="ids"
                        form={form}
                        name={`${key}.${operation}`}
                        // SAFETY: the declaration names a supported reference target, matching the normal multi-reference editor.
                        entity={field.reference.entity as never}
                        label={`${field.label} to ${operation}`}
                        SearchProvider={searchProviderFor(
                          field.reference.entity,
                        )}
                      />
                    ) : structuredList ? (
                      <fieldset
                        key={operation}
                        aria-label={`${field.label} to ${operation}`}
                      >
                        <StructuredValueField
                          form={form}
                          name={`${key}.${operation}`}
                          label={field.label}
                          schema={
                            operation === "add"
                              ? structuredList
                              : collectionRemoveSchema(
                                  structuredList,
                                  collectionIdentity(field),
                                )
                          }
                          arrayLabels={{
                            title: `${field.label} to ${operation}`,
                            ...(operation === "remove"
                              ? {
                                  add: "Choose item to remove",
                                  remove: "Cancel removal",
                                }
                              : {}),
                          }}
                          searchProviderFor={searchProviderFor}
                        />
                      </fieldset>
                    ) : (
                      <AliasesField
                        key={operation}
                        form={form}
                        name={`${key}.${operation}`}
                        title={`${field.label} to ${operation}`}
                        placeholder={`${field.label} to ${operation}`}
                      />
                    ),
                  )}
                </>
              ) : (
                renderIntentField({
                  queryClient,
                  entity,
                  field,
                  form,
                  idPrefix: `bulk-edit-${entity}`,
                  mode: "edit",
                  scopedValueRecord: form.getValues(),
                  assignment,
                })
              )}
            </fieldset>
          </fieldset>
        );
      })}
    </>
  );
}

const isSameValue = (a: BulkEditRowValue, b: BulkEditRowValue) =>
  (a ?? null) === (b ?? null);

/**
 * Boolean-vs-select is decided by the field's own declared `kind` — the
 * schema-derived contract for what this value IS — rather than a runtime
 * `typeof` guess at a value whose static type is already a closed union.
 */
function formatBulkEditValue(
  entity: Entity,
  field: PrimitiveFieldModel,
  value: BulkEditRowValue,
): string {
  if (value === null || value === undefined || value === "") return "—";
  if (field.kind === "boolean") return value ? "Yes" : "No";
  const options = presentEntitySelectOptions(
    entity,
    field.key,
    field.control?.options ?? [],
    "edit",
  );
  const match = options.find((option) => option.value === value);
  if (match) return match.label;
  return String(value);
}

/**
 * The dialog's own form instance — mounted only while rows are staged (see
 * `useBulkEditEntityAction`), so a fresh `useForm()` per open is exactly the
 * reset the plain tracker dialogs did by hand.
 *
 * Exported as a test seam: renders against a caller-supplied `onSubmit`, so a
 * test can assert the dirty-subset payload without a real entity mutation.
 */
export function BulkEditDialogBody({
  entity,
  items,
  fieldKeys: requestedFields,
  onOpenChange,
  onSubmit,
  isPending,
  searchProviderFor,
}: {
  entity: Entity;
  items: readonly BulkEditRow[];
  fieldKeys?: readonly string[];
  onOpenChange: (open: boolean) => void;
  onSubmit: (data: Readonly<BulkEditDraft>) => Promise<void>;
  isPending: boolean;
  /** Test seam: a fake reference-field search provider, in place of the real
   * `requireReferenceEntitySearch` lookup — see {@link SearchProviderFor}. */
  searchProviderFor?: SearchProviderFor;
}) {
  const queryClient = useQueryClient();
  const metadata = useEntityMetadata(entity);
  const model = metadata.fields;
  const fieldKeys =
    requestedFields ?? metadata.summary.bulkUpdate?.fields ?? [];
  // Match nullable controls' empty value so another field's dirty-state
  // recalculation never turns their initial null into a pending clear.
  const form = useForm<FieldValues>({
    defaultValues: Object.fromEntries(
      model.fields
        .filter(
          (field) =>
            fieldKeys.includes(field.key) &&
            field.nullable &&
            !isBulkCollection(field),
        )
        .map((field) => [field.key, null]),
    ),
  });
  const receiptHandler = useRef<((recordId: string) => Promise<void>) | null>(
    null,
  );
  // Reading `dirtyFields` here (not only inside a callback) is what
  // subscribes this component to RHF's proxy-tracked form state, so the
  // preview below and the submit payload both follow the live selection of
  // touched fields.
  const { dirtyFields } = form.formState;
  const [modes, setModes] = useState<Record<string, BulkFieldMode>>({});
  const dirtyKeys = fieldKeys.filter(
    (key) =>
      modes[key] === "clear" ||
      modes[key] === "set" ||
      Boolean(dirtyFields[key]) ||
      model.fields.some(
        (field) =>
          field.key === key &&
          [
            ...Object.keys(field.resolution?.reset ?? {}),
            ...Object.keys(field.resolution?.none ?? {}),
          ].some((companion) => companion !== key && dirtyFields[companion]),
      ),
  );
  // The shared date rule per selected row. When any row still needs a date
  // (a known non-zero cost), stand in a non-zero cost so clearing stays off;
  // null would now mean "unknown cost", which may clear it.
  const clearCost = items.every((item) => canClearExpenseDate(item.cost))
    ? 0
    : 1;
  const onModeChange = (field: PrimitiveFieldModel, mode: BulkFieldMode) => {
    form.clearErrors(field.key);
    const companions = new Set([
      field.key,
      ...Object.keys(field.resolution?.reset ?? {}),
      ...Object.keys(field.resolution?.none ?? {}),
    ]);
    if (mode === "unchanged") {
      for (const key of companions) {
        // Resolution companions and nested collections have no registered
        // root control; scalar controls return to the bulk form's empty baseline.
        if (
          isBulkCollection(field) ||
          !model.fields.find((candidate) => candidate.key === key)?.control
        )
          form.unregister(key);
        else form.resetField(key);
      }
      setModes((current) =>
        Object.fromEntries(
          Object.entries(current).filter(([key]) => !companions.has(key)),
        ),
      );
      return;
    }
    setModes((current) => ({ ...current, [field.key]: mode }));
    if (mode === "clear") {
      const patch = field.resolution?.none ?? { [field.key]: null };
      for (const [key, value] of Object.entries(patch)) {
        form.setValue(key, value, { shouldDirty: true, shouldTouch: true });
      }
    }
  };

  // Multi-row basis is ambiguous (which row's `name`/`vendor`/... would the decision model
  // read?) — suggestions are offered only when exactly one row is staged, and
  // the basis is a fixed snapshot of that row rather than a live RHF watch
  // (bulk edit's fields start untouched, not tied to any one row's value).
  const singleItem = items.length === 1 ? items[0] : null;
  const suggestionStaticBasis = useMemo(() => {
    if (!singleItem) return null;
    // SAFETY: bulk edit only ever mounts for `bulkEditEntities`, all of which
    // carry a shortcode prefix (the generic browser CRUD roster).
    const shortcodeEntity = entity as ShortcodeEntity;
    return fieldSuggestionBasisFromRecord(
      queryClient,
      shortcodeEntity,
      suggestTargetsFor(queryClient, shortcodeEntity, fieldKeys),
      singleItem,
    );
    // oxlint-disable-next-line react/exhaustive-deps -- `fieldKeys` is a stable per-entity roster; `entity` is a stable prop.
  }, [queryClient, singleItem]);

  const handleSubmit = form.handleSubmit(async (values) => {
    const data: BulkEditDraft = {};
    for (const key of dirtyKeys) {
      const value = modes[key] === "clear" ? null : values[key];
      const field = model.fields.find((candidate) => candidate.key === key);
      if (field && isBulkCollection(field)) {
        const patch = z
          .object({
            add: z.array(z.unknown()).default([]),
            remove: z.array(z.unknown()).default([]),
          })
          .parse(value ?? {});
        const identity = collectionIdentity(field);
        const structured = structuredSchemaFor(queryClient, entity, key);
        const normalized = (operation: "add" | "remove") => {
          const items = z
            .json()
            .parse(JSON.parse(JSON.stringify(patch[operation])));
          return z
            .array(z.json())
            .parse(
              structured
                ? wireValue(
                    items,
                    operation === "remove"
                      ? collectionRemoveSchema(structured, identity)
                      : structured,
                  )
                : items,
            );
        };
        const itemKey = (item: BulkEditFieldValue) =>
          identity === undefined || identity === "value"
            ? item
            : Object.fromEntries(
                Object.entries(
                  z.record(z.string(), z.json()).parse(item),
                ).filter(([key]) => identity.includes(key)),
              );
        const items = [
          ...normalized("remove").map((item) => ({
            op: "remove" as const,
            key: itemKey(item),
          })),
          ...normalized("add").map((item): BulkEditFieldValue =>
            identity === undefined || identity === "value"
              ? { op: "add", key: item }
              : {
                  op: "add",
                  key: itemKey(item),
                  value: Object.fromEntries(
                    Object.entries(
                      z.record(z.string(), z.json()).parse(item),
                    ).filter(([key]) => !identity.includes(key)),
                  ),
                },
          ),
        ];
        if (items.length === 0) {
          form.setError(key, {
            message: `Enter ${field.label} to add or remove.`,
          });
          return;
        }
        data[key] = items;
        continue;
      }
      const resolutionChosen = Object.keys(field?.resolution?.none ?? {}).some(
        (companion) => companion !== key && dirtyFields[companion],
      );
      if (
        modes[key] === "set" &&
        (value === null || value === undefined || value === "") &&
        !resolutionChosen
      ) {
        form.setError(key, {
          message: `Enter a value for ${field?.label ?? key}.`,
        });
        return;
      }
      // `PickerField` `store="id"` (used for every reference field here) writes ""
      // for "cleared", never `null` — its own convention for "no selection".
      data[key] = z
        .json()
        .parse(value === "" && field?.reference ? null : (value ?? null));
    }
    await onSubmit(data);
    if (singleItem) {
      try {
        await receiptHandler.current?.(singleItem.id);
      } catch (error) {
        showErrorToast(error, "Updated, but suggestion receipt failed");
      }
    }
  });

  return (
    <FormProvider {...form}>
      <BulkActionDialog
        open
        onOpenChange={onOpenChange}
        items={[...items]}
        action="Bulk edit"
        actionLabel="Update"
        pendingLabel="Updating..."
        itemNoun={entityLabel(entity)}
        description={`Update ${countLabel(items.length, entityLabel(entity).toLowerCase())}. Only the fields you change are written.`}
        renderItem={(item) => item.name}
        effect={(item) => {
          // A pristine form has no pending mutation. Keeping its rows quiet
          // avoids presenting a synthetic blocker before the operator chooses
          // any field, and the dialog's explicit submission gate prevents an
          // empty bulk update.
          if (dirtyKeys.length === 0) return undefined;
          const parts = dirtyKeys.map((key) => {
            const field = model.fields.find(
              (candidate) => candidate.key === key,
            );
            if (!field) return { current: "—", next: "—", unchanged: true };
            const nextValue =
              modes[key] === "clear" ? null : form.getValues(key);
            return {
              current: formatBulkEditValue(entity, field, item[key]),
              next: formatBulkEditValue(entity, field, nextValue),
              unchanged: isSameValue(item[key], nextValue),
            };
          });
          return {
            from: parts.map((part) => part.current).join(", "),
            to: parts.map((part) => part.next).join(", "),
            unchanged: parts.every((part) => part.unchanged),
          };
        }}
        unchangedLabel="already set to this"
        onSubmit={handleSubmit}
        isPending={isPending}
        submissionDisabled={dirtyKeys.length === 0}
      >
        {suggestionStaticBasis ? (
          <FieldSuggestionProvider
            // SAFETY: see the `suggestionStaticBasis` cast above.
            entity={entity as ShortcodeEntity}
            mode="edit"
            receiptHandler={receiptHandler}
            staticBasis={suggestionStaticBasis}
            fieldKeys={fieldKeys}
          >
            <BulkEditFields
              entity={entity}
              fieldKeys={fieldKeys}
              form={form}
              searchProviderFor={searchProviderFor}
              modes={modes}
              onModeChange={onModeChange}
              clearCost={clearCost}
            />
          </FieldSuggestionProvider>
        ) : (
          <BulkEditFields
            entity={entity}
            fieldKeys={fieldKeys}
            form={form}
            searchProviderFor={searchProviderFor}
            modes={modes}
            onModeChange={onModeChange}
            clearCost={clearCost}
          />
        )}
      </BulkActionDialog>
    </FormProvider>
  );
}

/**
 * The generic `bulkEdit` verb: stages the selected rows, then edits
 * the derived bulk field roster through {@link BulkEditFields}. The
 * mutation payload is RHF's `dirtyFields` subset — a field the user never
 * touched is omitted entirely, and a nullable reference or select field the
 * user clears sends `null` — never the full form, which would blow away
 * every row's other fields with whatever this dialog's untouched defaults are.
 */
export function useBulkEditEntityAction(
  entity: ShortcodeEntity,
  {
    verb = "bulkEdit",
    fields,
  }: {
    verb?: ActionVerbId;
    /** A single-field verb edits only these declared fields. */
    fields?: readonly string[];
  } = {},
): EntityActionHandles {
  const queryClient = useQueryClient();
  const [items, setItems] = useState<BulkEditRow[]>([]);
  const mutation = useActionMutation({
    mutationFn: bulkUpdateMutationOptionsFactory(entity),
    success: (data) =>
      `Updated ${countLabel(data.updated, entityLabel(entity).toLowerCase())}`,
  });
  const stage = useCallback(
    async (rows: readonly EntityActionRow[]) => {
      await ensureEntityMetadata(queryClient, entity);
      setItems(rows.map(asBulkEditRow));
    },
    [entity, queryClient],
  );

  const submit = useCallback(
    async (data: Readonly<BulkEditDraft>) => {
      await mutation.mutateAsync({
        ids: items.map((item) => item.id),
        data: { ...data },
      });
      setItems([]);
    },
    // oxlint-disable-next-line react/exhaustive-deps -- mutation wrappers change identity every render; their operation contracts are stable.
    [items],
  );

  return {
    run: async (rows) => {
      await stage(rows);
      return { success: true };
    },
    rowMenuItem: (row) => (
      <VerbMenuItem
        verb={verb}
        onSelect={(event) => {
          event.stopPropagation();
          void stage([row]).catch((error) => showErrorToast(error));
        }}
      />
    ),
    dialog: items.length > 0 && (
      <BulkEditDialogBody
        entity={entity}
        items={items}
        fieldKeys={fields}
        onOpenChange={(open) => {
          if (!open) setItems([]);
        }}
        onSubmit={submit}
        isPending={mutation.isPending}
      />
    ),
  };
}
