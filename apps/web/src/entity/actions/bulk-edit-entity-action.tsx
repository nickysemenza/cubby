import { entityIndex } from "@cubby/schemas/entity-index";
import type { UseMutationOptions } from "@tanstack/react-query";
import { type ComponentProps, Suspense, useCallback, useState } from "react";

import { entityLabel } from "~/entity/entities";
import { entityMutationOptionsFactory } from "~/entity/entity-contracts";
import { entitySummaryOf } from "~/entity/entity-model";
import {
  generatedBrowserCrudEntities,
  type GeneratedBrowserCrudEntity,
} from "~/entity/generated/entity-routes.gen";
import { browserOnlyLazy } from "~/lib/browser-only-lazy";
import { countLabel } from "~/lib/pluralize";

import { useActionMutation } from "../../ui/hooks/useActionMutation";
import { VerbMenuItem } from "./action-verb-ui";
import type { ActionVerbId } from "./action-verbs";
import type {
  BulkEditDialogBody as BulkEditDialogBodyComponent,
  BulkEditDraft,
  BulkEditResult,
  BulkEditRow,
  BulkEditVariables,
} from "./bulk-edit-dialog-body";
import type { EntityActionHandles, EntityActionRow } from "./entity-actions";

// Interaction-only: the bulk-edit form (react-hook-form and the editor field
// controls) loads when rows are staged for a bulk edit.
const BulkEditDialogBody = browserOnlyLazy<
  ComponentProps<typeof BulkEditDialogBodyComponent>
>(
  import.meta.env.SSR
    ? null
    : () =>
        import("./bulk-edit-dialog-body").then((module) => ({
          default: module.BulkEditDialogBody,
        })),
);

/**
 * Entities whose manifest declares `capabilities.bulkUpdate` — the generic
 * `bulkEdit` verb's roster. Derived from the slim index's `bulkUpdate` flag
 * (the generator's `bulkUpdateFor`, shared with the inspector's
 * `lifecycle.bulkUpdate`). Not `entityFieldModel(entity).bulk`: a bulk update
 * may name a field the field model does not mark bulk-editable (Expense
 * `date`). Never from server bindings either: a bindings-derived list would
 * follow whichever entities the kernel happens to wire up rather than what the
 * manifest declares editable in bulk.
 */
export const bulkEditEntities: readonly GeneratedBrowserCrudEntity[] =
  generatedBrowserCrudEntities.filter(
    (entity) => entityIndex[entity].bulkUpdate,
  );

const asBulkEditRow = (row: EntityActionRow): BulkEditRow => ({
  ...row,
  name: row.name || row.id,
});

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
  const fieldKeys = fields ?? entitySummaryOf(entity).bulkUpdate?.fields ?? [];

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
      <Suspense fallback={null}>
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
      </Suspense>
    ),
  };
}
