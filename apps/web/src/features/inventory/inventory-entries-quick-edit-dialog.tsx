import { fieldValueOf } from "@cubby/schemas/field-envelope";
import type { LocationShortcode } from "@cubby/schemas/identifiers";
import type { ProductListInventoryEntryOut } from "@cubby/schemas/product";

import { entityMutationOptionsFactory } from "~/entity/entity-contracts";
import { useUpdateMutation } from "~/entity/hooks/use-update-mutation";
import { buildRecordComboboxItem } from "~/entity/picker/combobox-builders";
import {
  useEntityListSource,
  type SearchProviderProps,
} from "~/entity/picker/with-search-hook";
import { EditableAmountCell } from "~/entity/table/editable-cell";
import { EditableEntityCell } from "~/entity/table/editable-entity-cell";
import { FieldRecordValue } from "~/ui/derived/record-value";
import { Row, Stack } from "~/ui/layout";
import { Overlay } from "~/ui/overlays/overlay";
import { NoneValue } from "~/ui/primitives/none-value";

/**
 * The location search provider for every entry row's `EditableEntityCell` —
 * a stable top-level component (not one defined inline per row) so
 * `useEntityListSource` is called through a proper component reference
 * rather than a fresh callback on each `entries.map()` iteration.
 */
function LocationSearchProvider(props: SearchProviderProps<LocationShortcode>) {
  const { dialog, ...search } = useEntityListSource("location", {
    scope: props.scope,
  });
  return (
    <>
      {dialog}
      {props.children(search)}
    </>
  );
}

type QuickEditInventoryEntry = ProductListInventoryEntryOut;

interface InventoryEntriesQuickEditDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  productName: string;
  /**
   * Keep this derived from live list data (not a row snapshot) so saved edits
   * reflect back into the open dialog after invalidation.
   */
  entries: QuickEditInventoryEntry[];
}

/**
 * Quick-edit surface for a product's inventory entries, opened from the
 * Locations cell on the products list. Each entry row edits its amount and
 * location in place with the standard inline-cell semantics (pencil → editor →
 * Check/X, optimistic display, toast on error); the inventory ripple includes
 * the product list, so the row behind the dialog refreshes too.
 */
export function InventoryEntriesQuickEditDialog({
  open,
  onOpenChange,
  productName,
  entries,
}: InventoryEntriesQuickEditDialogProps) {
  const updateInventoryMutation = useUpdateMutation({
    mutationFn: entityMutationOptionsFactory("inventory", "update"),
    entity: "inventory",
  });

  return (
    <Overlay
      open={open}
      onOpenChange={onOpenChange}
      size="md"
      title="Edit Inventory"
      description={`Amounts and locations for "${productName}". Changes save immediately.`}
      cancelLabel="Done"
    >
      <Stack gap="xs">
        {entries.length === 0 ? (
          <p className="text-sm text-muted-foreground">No inventory entries.</p>
        ) : (
          entries.map((entry) => {
            const amount = fieldValueOf(entry.fields.amount);
            return (
              <Row key={entry.id} align="center" gap="sm" wrap>
                <FieldRecordValue record={entry} field="amount">
                  {amount ? (
                    <EditableAmountCell
                      amount={amount}
                      onSave={async (newAmount) => {
                        await updateInventoryMutation.mutateAsync({
                          id: entry.id,
                          data: { amount: newAmount },
                        });
                      }}
                    />
                  ) : (
                    <NoneValue />
                  )}
                </FieldRecordValue>
                <span className="text-muted-foreground/50">@</span>
                <EditableEntityCell
                  value={buildRecordComboboxItem("location", entry.location)}
                  label="location"
                  SearchProvider={LocationSearchProvider}
                  onSave={async (newLocationId) => {
                    if (!newLocationId) return;
                    await updateInventoryMutation.mutateAsync({
                      id: entry.id,
                      data: { locationId: newLocationId },
                    });
                  }}
                  renderValue={(v) =>
                    v ? (
                      <Row as="span" align="center" gap="xs">
                        {v.icon}
                        <span className="truncate">{v.name}</span>
                      </Row>
                    ) : null
                  }
                />
              </Row>
            );
          })
        )}
      </Stack>
    </Overlay>
  );
}
