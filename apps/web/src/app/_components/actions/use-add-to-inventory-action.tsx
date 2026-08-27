import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import { useCallback, useState } from "react";
import type { BulkAddProduct } from "../products/product-bulk-add-to-inventory-dialog";
import { ProductBulkAddToInventoryDialog } from "../products/product-bulk-add-to-inventory-dialog";
import { VerbMenuItem } from "./action-verb-ui";
import type { EntityActionHandles, EntityActionRow } from "./entity-actions";

/**
 * "Add to inventory" for one product or a whole selection.
 *
 * Registered once and resolved by entity, so the same verb reaches the product
 * table's selection bar, all three product row menus, the product detail
 * header and the command palette without any of them wiring it. Before this it
 * was a row-only affordance repeated on three tables, and stocking an order
 * meant opening the dialog once per line and re-picking the same shelf.
 *
 * Rows are read structurally rather than through a row type: the four surfaces
 * that offer this verb hand over four different shapes (a product list row, a
 * purchase line, a project resource, a resolved shortcode), and all this needs
 * from any of them is a name to show beside a quantity field.
 */
const asBulkAddProduct = (row: EntityActionRow): BulkAddProduct => {
  const named = row as EntityActionRow & {
    name?: unknown;
    manufacturer?: unknown;
  };
  return {
    id: parseShortcodeFor("product", row.id),
    name: typeof named.name === "string" && named.name ? named.name : row.id,
    manufacturer:
      typeof named.manufacturer === "string" ? named.manufacturer : null,
  };
};

export function useAddToInventoryAction(): EntityActionHandles {
  const [staged, setStaged] = useState<BulkAddProduct[]>([]);

  const stage = useCallback((rows: readonly EntityActionRow[]) => {
    setStaged(rows.map(asBulkAddProduct));
  }, []);

  const run = useCallback(
    async (rows: readonly EntityActionRow[]) => {
      stage(rows);
      // The write happens in the dialog, so the bar's job is done once the
      // rows are staged — and the selection survives, because a cancelled
      // dialog should leave the operator where they were.
      return { success: true };
    },
    [stage],
  );

  return {
    run,
    rowMenuItem: (row) => (
      <VerbMenuItem
        key="add-to-inventory"
        verb="addToInventory"
        onSelect={(event) => {
          event.stopPropagation();
          stage([row]);
        }}
      />
    ),
    dialog: (
      <ProductBulkAddToInventoryDialog
        key="add-to-inventory"
        open={staged.length > 0}
        onOpenChange={(open) => {
          if (!open) setStaged([]);
        }}
        products={staged}
      />
    ),
  };
}
