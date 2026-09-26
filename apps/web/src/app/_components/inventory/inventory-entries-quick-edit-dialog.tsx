import type { Amount } from "@cubby/schemas/codec";
import type {
  InventoryShortcode,
  LocationShortcode,
} from "@cubby/schemas/identifiers";
import type { LocationType } from "@cubby/schemas/location";

import { buildLocationComboboxItem } from "~/app/_components/combobox/combobox-builders";
import {
  useEntityListSource,
  type SearchProviderProps,
} from "~/app/_components/combobox/with-search-hook";
import { EditableAmountCell } from "~/app/_components/data-table/editable-cell";
import { EditableEntityCell } from "~/app/_components/data-table/editable-entity-cell";
import { useUpdateMutation } from "~/app/_components/hooks/useUpdateMutation";
import { Row, Stack } from "~/components/layout";
import { Button } from "~/components/ui/button";
import { ResponsiveDialog } from "~/components/ui/responsive-dialog";
import { entityMutationOptionsFactory } from "~/entities/entity-contracts";

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

interface QuickEditInventoryEntry {
  id: InventoryShortcode;
  amount: Amount;
  location: { id: LocationShortcode; name: string; type: LocationType | null };
}

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
    <ResponsiveDialog
      open={open}
      onOpenChange={onOpenChange}
      size="md"
      title="Edit Inventory"
      description={`Amounts and locations for "${productName}". Changes save immediately.`}
      footer={
        <Row justify="end">
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            Done
          </Button>
        </Row>
      }
    >
      <Stack gap="xs">
        {entries.length === 0 ? (
          <p className="text-sm text-muted-foreground">No inventory entries.</p>
        ) : (
          entries.map((entry) => (
            <Row key={entry.id} align="center" gap="sm" wrap>
              <EditableAmountCell
                amount={entry.amount}
                onSave={async (newAmount) => {
                  await updateInventoryMutation.mutateAsync({
                    id: entry.id,
                    data: { amount: newAmount },
                  });
                }}
              />
              <span className="text-muted-foreground/50">@</span>
              <EditableEntityCell
                value={buildLocationComboboxItem(entry.location)}
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
          ))
        )}
      </Stack>
    </ResponsiveDialog>
  );
}
