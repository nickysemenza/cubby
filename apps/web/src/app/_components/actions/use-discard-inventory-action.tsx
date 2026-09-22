import {
  inventoryShortcode,
  locationShortcode,
  productShortcode,
} from "@cubby/schemas/identifiers";
import { useCallback, useState } from "react";
import { z } from "zod";

import { BulkDiscardInventoryDialog } from "../inventory/bulk-discard-inventory-dialog";
import type { InventoryDialogItem } from "../inventory/dialog-item";
import { VerbMenuItem } from "./action-verb-ui";
import type { EntityActionHandles, EntityActionRow } from "./entity-actions";

/**
 * "Discard" for one shelf row or a whole selection of them.
 *
 * Registered for `inventory`, not `product`, and that is the whole design. A
 * product row is a product — one that sits on two shelves still needs a
 * per-row shelf choice, which is why `productlist` keeps its own single-row
 * discard and this verb never reaches it. An inventory row already names its
 * amount and its shelf, so a selection of them is a complete instruction and
 * bulk discard is *simpler* here than the flow it replaces: the single-row
 * dialog fetched the whole product only to ask "which shelf?".
 *
 * Rows are read structurally rather than through a row type: the three
 * inventory tables hand over three different shapes (a list row with a full
 * product summary, a location row, a product-detail row that knows its product
 * from the page). A row that does not parse gets no menu item at all — which
 * is how `product-stocked-at`'s identity rows, Locations that *are* the
 * product rather than entries holding it, stay out of this.
 */
const discardableRow = z.object({
  id: inventoryShortcode,
  amount: z.object({ value: z.number(), unit: z.string() }),
  location: z.object({ id: locationShortcode, name: z.string() }),
  product: z.object({ id: productShortcode, name: z.string() }),
});

const asDiscardItem = (row: EntityActionRow): InventoryDialogItem | null => {
  const parsed = discardableRow.safeParse(row);
  return parsed.success ? parsed.data : null;
};

export function useDiscardInventoryAction(): EntityActionHandles {
  const [staged, setStaged] = useState<InventoryDialogItem[]>([]);

  const run = useCallback(async (rows: readonly EntityActionRow[]) => {
    const items = rows.flatMap((row) => {
      const item = asDiscardItem(row);
      return item ? [item] : [];
    });
    if (items.length !== rows.length || items.length === 0) {
      return { success: false };
    }
    setStaged(items);
    // The write happens in the dialog, so the bar's job is done once the rows
    // are staged — and the selection survives, because a cancelled dialog
    // should leave the operator where they were.
    return { success: true };
  }, []);

  return {
    run,
    availability: ({ rows }) =>
      rows.length > 0 && rows.every((row) => asDiscardItem(row) !== null)
        ? { status: "available" }
        : { status: "hidden" },
    rowMenuItem: (row) => {
      const item = asDiscardItem(row);
      if (!item) return null;
      return (
        <VerbMenuItem
          key="discard"
          verb="discard"
          onSelect={(event) => {
            event.stopPropagation();
            setStaged([item]);
          }}
        />
      );
    },
    dialog: (
      <BulkDiscardInventoryDialog
        open={staged.length > 0}
        onOpenChange={(open) => {
          if (!open) setStaged([]);
        }}
        items={staged}
      />
    ),
  };
}
