import type { Entity } from "@cubby/schemas/entity";
import { entityFieldModels } from "@cubby/schemas/entity-fields";
import type { ShortcodeEntity } from "@cubby/schemas/entity-manifest";
import { entitySummary } from "@cubby/schemas/entity-summary";
import { canClearExpenseDate } from "@cubby/schemas/expense-fields";
import type { MutationSideEffects } from "@cubby/schemas/mutation-side-effects";
import type { UseMutationOptions } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";
import {
  FormProvider,
  useForm,
  type FieldValues,
  type UseFormReturn,
} from "react-hook-form";

import {
  renderIntentField,
  type PrimitiveFieldModel,
  type SearchProviderFor,
} from "~/entity/editing/entity-primitive-fields";
import { fieldClearing } from "~/entity/editing/field-clearing";
import { presentEntitySelectOptions } from "~/entity/editing/select-options";
import { entityLabel } from "~/entity/entities";
import { entityMutationOptionsFactory } from "~/entity/entity-contracts";
import {
  generatedBrowserCrudEntities,
  type GeneratedBrowserCrudEntity,
} from "~/entity/generated/entity-routes.gen";
import {
  fieldSuggestionBasisFromRecord,
  suggestTargetsFor,
} from "~/features/ai/field-suggestion";
import { FieldSuggestionProvider } from "~/features/ai/field-suggestion-provider";
import { countLabel } from "~/lib/pluralize";
import { requireReferenceEntitySearch } from "~/ui/combobox/reference-entity-search";
import { BulkActionDialog } from "~/ui/dialogs/bulk-action-dialog";
import { Row } from "~/ui/layout";
import { Button } from "~/ui/primitives/button";

import { useActionMutation } from "../../ui/hooks/useActionMutation";
import { VerbMenuItem } from "./action-verb-ui";
import type { ActionVerbId } from "./action-verbs";
import type { EntityActionHandles, EntityActionRow } from "./entity-actions";

/**
 * Entities whose manifest declares `capabilities.bulkUpdate` — the generic
 * `bulkEdit` verb's roster. Derived from `entitySummary[entity].bulkUpdate`
 * (the generator's `bulkUpdateFor`, shared with the inspector's
 * `lifecycle.bulkUpdate`). Not `entityFieldModels[entity].bulk`: a bulk update
 * may name a field the field model does not mark bulk-editable (Expense
 * `date`). Never from server bindings either: a bindings-derived list would
 * follow whichever entities the kernel happens to wire up rather than what the
 * manifest declares editable in bulk.
 */
export const bulkEditEntities: readonly GeneratedBrowserCrudEntity[] =
  generatedBrowserCrudEntities.filter(
    (entity) => entitySummary[entity].bulkUpdate !== null,
  );

/**
 * What a bulk-edit form field actually produces: select and reference
 * controls write a string (a select's value, or a picker's shortcode/`""`
 * for "cleared"); checkbox writes a boolean. Explicit modes distinguish an
 * untouched empty control from a requested clear.
 */
type BulkEditFieldValue = string | number | boolean | null;
type BulkFieldMode = "unchanged" | "set" | "clear";

/** The submit payload: `capabilities.bulkUpdate.fields` keys the dirty subset. */
export type BulkEditDraft = Record<string, BulkEditFieldValue>;
type BulkEditVariables = { ids: string[]; data: BulkEditDraft };
type BulkEditResult = { updated: number; sideEffects: MutationSideEffects };

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
 * Renders `capabilities.bulkUpdate.fields` in roster order. Each field's
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
  const model = entityFieldModels[entity];
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
        // Companion assignment modes are written by the value field controls.
        if (!field.control) return null;
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
                {field.nullable ? (
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
              {renderIntentField({
                entity,
                field,
                form,
                idPrefix: `bulk-edit-${entity}`,
                mode: "edit",
                // No bulk-editable reference declares a dependent scope.
                scopedValueRecord: {},
                assignment,
              })}
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
  fieldKeys,
  onOpenChange,
  onSubmit,
  isPending,
  searchProviderFor,
}: {
  entity: Entity;
  items: readonly BulkEditRow[];
  fieldKeys: readonly string[];
  onOpenChange: (open: boolean) => void;
  onSubmit: (data: Readonly<BulkEditDraft>) => Promise<void>;
  isPending: boolean;
  /** Test seam: a fake reference-field search provider, in place of the real
   * `requireReferenceEntitySearch` lookup — see {@link SearchProviderFor}. */
  searchProviderFor?: SearchProviderFor;
}) {
  const form = useForm<FieldValues>();
  // Reading `dirtyFields` here (not only inside a callback) is what
  // subscribes this component to RHF's proxy-tracked form state, so the
  // preview below and the submit payload both follow the live selection of
  // touched fields.
  const { dirtyFields } = form.formState;
  const model = entityFieldModels[entity];
  const [modes, setModes] = useState<Record<string, BulkFieldMode>>({});
  const dirtyKeys = fieldKeys.filter(
    (key) =>
      modes[key] === "clear" ||
      modes[key] === "set" ||
      Boolean(dirtyFields[key]),
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
        // Companion modes are programmatic writes, with no registered input
        // for resetField to reset. Unregister removes their pending patch.
        if (model.fields.find((candidate) => candidate.key === key)?.control)
          form.resetField(key);
        else form.unregister(key);
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

  // Multi-row basis is ambiguous (which row's `name`/`vendor`/... would Jev
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
      shortcodeEntity,
      suggestTargetsFor(shortcodeEntity, fieldKeys),
      singleItem,
    );
    // oxlint-disable-next-line react/exhaustive-deps -- `fieldKeys` is a stable per-entity roster; `entity` is a stable prop.
  }, [singleItem]);

  const handleSubmit = form.handleSubmit(async (values) => {
    const data: BulkEditDraft = {};
    for (const key of dirtyKeys) {
      const value = modes[key] === "clear" ? null : values[key];
      const field = model.fields.find((candidate) => candidate.key === key);
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
      // `EntityValueField` (used for every reference field here) writes ""
      // for "cleared", never `null` — its own convention for "no selection".
      // No bulk-edit field kind is free text, so folding "" into null here is
      // unambiguous: a cleared reference is exactly what should send `null`.
      data[key] = value === "" ? null : (value ?? null);
    }
    await onSubmit(data);
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
 * `capabilities.bulkUpdate.fields` through {@link BulkEditFields}. The
 * mutation payload is RHF's `dirtyFields` subset — a field the user never
 * touched is omitted entirely, and a nullable reference or select field the
 * user clears sends `null` — never the full form, which would blow away
 * every row's other fields with whatever this dialog's untouched defaults are.
 */
export function useBulkEditEntityAction(
  entity: GeneratedBrowserCrudEntity,
  {
    verb = "bulkEdit",
    fields,
    updateEach = false,
  }: {
    verb?: ActionVerbId;
    /** A single-field verb edits only these declared fields. */
    fields?: readonly string[];
    /** For an entity without a bulk-update contract: one update per row. */
    updateEach?: boolean;
  } = {},
): EntityActionHandles {
  const [items, setItems] = useState<BulkEditRow[]>([]);
  const update = useActionMutation({
    // SAFETY: as below — the kernel re-parses `data` against the entity's
    // update input, and the draft only holds keys from `fields`.
    mutationFn: entityMutationOptionsFactory(
      entity,
      "update",
    ) as () => UseMutationOptions<
      unknown,
      Error,
      { id: string; data: BulkEditDraft }
    >,
  });
  const bulkUpdate = entityMutationOptionsFactory(entity, "bulkUpdate");
  const mutation = useActionMutation({
    // SAFETY: the kernel re-parses `data` against this entity's generated
    // `bulkUpdateInput` before writing (`entity-operations.ts` bulkUpdate),
    // and the draft only ever holds keys from that entity's
    // `bulkUpdate.fields`; the per-entity variables union collapses to the
    // roster-keyed draft at this seam.
    mutationFn: bulkUpdate as () => UseMutationOptions<
      BulkEditResult,
      Error,
      BulkEditVariables
    >,
    success: (data) =>
      `Updated ${countLabel(data.updated, entityLabel(entity).toLowerCase())}`,
  });
  // Invariant: `entity` is only ever one of `bulkEditEntities`, all of which
  // declare a non-null `capabilities.bulkUpdate` — the `?? []` is a defensive
  // fallback, not an expected path.
  const fieldKeys = fields ?? entitySummary[entity].bulkUpdate?.fields ?? [];

  const stage = useCallback((rows: readonly EntityActionRow[]) => {
    setItems(rows.map(asBulkEditRow));
  }, []);

  const submit = useCallback(
    async (data: Readonly<BulkEditDraft>) => {
      if (updateEach) {
        for (const item of items) {
          await update.mutateAsync({ id: item.id, data: { ...data } });
        }
      } else {
        await mutation.mutateAsync({
          ids: items.map((item) => item.id),
          // SAFETY: `data` is built from this entity's own declared
          // `capabilities.bulkUpdate.fields`; the generic mutation factory
          // cannot express a runtime-selected field subset per entity.
          data: data as never,
        });
      }
      setItems([]);
    },
    // oxlint-disable-next-line react/exhaustive-deps -- mutation wrappers change identity every render; their operation contracts are stable.
    [items, updateEach],
  );

  return {
    run: async (rows) => {
      stage(rows);
      return { success: true };
    },
    rowMenuItem: (row) => (
      <VerbMenuItem
        verb={verb}
        onSelect={(event) => {
          event.stopPropagation();
          stage([row]);
        }}
      />
    ),
    dialog: items.length > 0 && (
      <BulkEditDialogBody
        entity={entity}
        items={items}
        fieldKeys={fieldKeys}
        onOpenChange={(open) => {
          if (!open) setItems([]);
        }}
        onSubmit={submit}
        isPending={mutation.isPending || update.isPending}
      />
    ),
  };
}
