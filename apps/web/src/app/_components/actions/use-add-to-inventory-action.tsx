import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";

import { entityDetailFor } from "~/entities/entity-detail.functions";

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
function hasStringManufacturer(
  row: EntityActionRow,
): row is EntityActionRow & { manufacturer: string } {
  return "manufacturer" in row && typeof row.manufacturer === "string";
}

const asBulkAddProduct = (row: EntityActionRow): BulkAddProduct => {
  const manufacturer = hasStringManufacturer(row) ? row.manufacturer : null;
  return {
    id: parseShortcodeFor("product", row.id),
    name: row.name || row.id,
    manufacturer,
  };
};

export function useAddToInventoryAction(): EntityActionHandles {
  const [staged, setStaged] = useState<BulkAddProduct[]>([]);

  const stage = useCallback((rows: readonly EntityActionRow[]) => {
    setStaged(rows.map(asBulkAddProduct));
  }, []);

  // One staged product is the only case that can carry the kit warning, and
  // it is the case every surface but the selection bar produces. Fetching the
  // detail here rather than taking it as a prop is what moved the warning off
  // the product page: invoked from a row menu or the palette, stocking a kit
  // whose parts are already on shelves used to over-account in silence.
  //
  // It also supplies the name and manufacturer for rows that carry only an id
  // — an expense line names a `productId` and nothing else.
  const soleProduct = staged.length === 1 ? staged[0] : undefined;
  const { data: detail } = useQuery({
    ...entityDetailFor("product").queryOptions(soleProduct?.id ?? ""),
    enabled: soleProduct !== undefined,
  });

  const soleWithDetail = useMemo(() => {
    if (!soleProduct) return undefined;
    if (!detail || detail.id !== soleProduct.id) return soleProduct;
    return {
      id: soleProduct.id,
      name: detail.name,
      manufacturer: detail.manufacturer,
    };
  }, [soleProduct, detail]);

  const accounting = useMemo(() => {
    if (!detail || detail.id !== soleProduct?.id) return undefined;
    return {
      expectedQuantity: detail.quantityLedger.expectedQuantity,
      ownOnHandUnits: detail.onHandUnits,
      componentCount: detail.componentCount,
    };
  }, [detail, soleProduct]);

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
        open={staged.length > 0}
        onOpenChange={(open) => {
          if (!open) setStaged([]);
        }}
        products={soleWithDetail ? [soleWithDetail] : staged}
        accounting={accounting}
      />
    ),
  };
}
