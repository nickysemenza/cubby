import type { ProductShortcode } from "@cubby/schemas/identifiers";
import type { KitComponentRowOut } from "@cubby/schemas/product-components";
import type { PurchaseProductOut } from "@cubby/schemas/purchase";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { VerbMenuItem } from "~/app/_components/actions/action-verb-ui";
import {
  createActionsColumn,
  createCurrencyColumn,
  createImageColumn,
  createNameColumn,
} from "~/app/_components/data-table/columnHelpers";
import RTable from "~/app/_components/data-table/Table";
import {
  type CubbyColumnDef,
  createCubbyColumnHelper,
  useCubbyTable,
} from "~/app/_components/data-table/table-features";
import { useCubbyTableLayout } from "~/app/_components/data-table/table-layout";
import { useActionMutation } from "~/app/_components/hooks/useActionMutation";
import { ProductAddToInventoryDialog } from "~/app/_components/products/product-add-to-inventory-dialog";
import { product } from "~/app/products/product.functions";
import { groupComponentsByParent } from "~/app/products/product-kit-rows";
import { Badge } from "~/components/ui/badge";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "~/components/ui/empty";
import { isUnspecifiedManufacturer } from "~/lib/manufacturer-utils";
import { invalidatesFor } from "~/lib/query-keys";
import { purchase } from "./purchase.functions";

const EMPTY_PRODUCTS: PurchaseProductOut[] = [];
const EMPTY_KIT_ROWS: KitComponentRowOut[] = [];

type PurchaseProductRow = {
  /**
   * Unique table row key — namespaced `${kitId}:${componentId}` on a component
   * row. `id` stays the real product shortcode at both depths so every link and
   * mutation keeps working; only `getRowId` reads this. See the note on
   * `ProductTreeRow.rowKey` for why that split matters.
   */
  id: ProductShortcode;
  rowKey: string;
  name: string;
  manufacturer: string;
  price: number | null;
  /** An explicit `PurchaseProduct` row exists — the only detachable case. */
  linked: boolean;
  /** Present only on a component row. */
  isComponent?: boolean;
  images: Array<{ id: string; url: string; filename: string }>;
  subRows?: PurchaseProductRow[];
};

export function PurchaseProductsTable({ purchaseId }: { purchaseId: string }) {
  const query = useQuery(purchase.products.queryOptions({ purchaseId }));
  const items = query.data ?? EMPTY_PRODUCTS;
  // Kits among this order's products. Gated on `componentCount` so the vast
  // majority of purchases (22 of ~3,450 contain a kit) fire no extra query.
  const kitIds = useMemo(
    () =>
      items.filter((item) => item.componentCount > 0).map((i) => i.productId),
    [items],
  );
  const kitComponentsQuery = useQuery({
    ...product.kitComponentRows.queryOptions({ parentProductIds: kitIds }),
    enabled: kitIds.length > 0,
  });
  const componentsByParent = useMemo(
    () => groupComponentsByParent(kitComponentsQuery.data ?? EMPTY_KIT_ROWS),
    [kitComponentsQuery.data],
  );

  const rows = useMemo<PurchaseProductRow[]>(
    () =>
      items.map((item) => {
        const imagesFor = (id: string, url: string | null, name: string) =>
          url ? [{ id: `cover:${id}`, url, filename: name }] : [];
        const components = componentsByParent.get(item.productId) ?? [];
        const row: PurchaseProductRow = {
          id: item.productId,
          rowKey: item.productId,
          name: item.productName,
          manufacturer: item.manufacturer,
          price: item.price,
          linked: item.linkAttachedAt !== null,
          images: imagesFor(
            item.productId,
            item.coverImageUrl,
            item.productName,
          ),
        };
        if (components.length === 0) return row;
        return {
          ...row,
          // No `subRows` key at all when empty, so `getCanExpand()` is false and
          // the name column renders no dead chevron.
          subRows: components.map((component) => ({
            id: component.product.id,
            rowKey: `${item.productId}:${component.product.id}`,
            name: component.product.name,
            manufacturer: component.product.manufacturer,
            price: component.product.price,
            // A component was never attached to this order — the kit was.
            linked: false,
            isComponent: true,
            // The list row carries the full image array rather than the single
            // cover URL the purchase projection uses; first is the cover.
            images: imagesFor(
              component.product.id,
              component.product.images[0]?.url ?? null,
              component.product.name,
            ),
          })),
        };
      }),
    [items, componentsByParent],
  );
  const detach = useActionMutation({
    mutationFn: purchase.detachProducts.mutationOptions,
    // See the twin in `product-purchases.tsx`: detaching clears the explicit
    // link only, and an expense-backed row stays listed.
    success: "Link removed — any itemized expense still relates these",
    invalidateKeys: invalidatesFor("purchase", "product"),
  });
  const [addToInventoryRow, setAddToInventoryRow] =
    useState<PurchaseProductRow | null>(null);
  const helper = useMemo(
    () => createCubbyColumnHelper<PurchaseProductRow>(),
    [],
  );
  const columns = useMemo<CubbyColumnDef<PurchaseProductRow>[]>(
    () => [
      createImageColumn(helper, { entity: "product" }),
      createNameColumn(helper, "product", "name", {
        header: "Product",
        expandable: true,
      }),
      helper.accessor((row) => row.manufacturer, {
        id: "manufacturer",
        header: "Manufacturer",
        meta: {
          className: "w-40",
          mobile: { slot: "subtitle", label: "Maker" },
        },
        cell: (info) =>
          isUnspecifiedManufacturer(info.getValue()) ? "—" : info.getValue(),
      }),
      createCurrencyColumn(helper, "price", {
        header: "Price",
        mobile: { slot: "meta", priority: 20 },
      }),
      // Badge the exception: most rows are derived from this order's itemized
      // expenses, and the explicit link is both rarer and the only detachable
      // one. Mirrors the marker in `product-purchases.tsx`.
      helper.accessor((row) => row.linked, {
        id: "link",
        header: "",
        // Blank header ⇒ no sorting: the sort control is a button labelled by
        // the header text, so an empty one has no accessible name. See the
        // twin in `_components/products/product-purchases.tsx`.
        enableSorting: false,
        meta: {
          className: "w-24",
          mobile: { slot: "meta", priority: 30 },
        },
        cell: (info) =>
          info.getValue() ? <Badge variant="outline">Linked</Badge> : null,
      }),
      createActionsColumn(helper, "product", {
        // Expense-derived rows have no link to remove; detach would no-op and
        // leave the row in place. Clear the Expense's product instead.
        extraActions: (row) => (
          <>
            <VerbMenuItem
              verb="addToInventory"
              onSelect={(event) => {
                event.stopPropagation();
                setAddToInventoryRow(row);
              }}
            />
            {row.linked && (
              <VerbMenuItem
                verb="removeFromPurchase"
                disabled={detach.isPending}
                onSelect={(event) => {
                  event.stopPropagation();
                  detach.mutate({ purchaseId, productIds: [row.id] });
                }}
              />
            )}
          </>
        ),
      }),
    ],
    [detach, helper, purchaseId],
  );
  const layout = useCubbyTableLayout({ key: "purchase:products", columns });
  const table = useCubbyTable({
    data: rows,
    columns: layout.columns,
    atoms: layout.atoms,
    meta: { defaultLayout: layout.defaultLayout },
    // `rowKey`, not `id`: a component can appear under two kits on one order.
    getRowId: (row) => row.rowKey,
    getSubRows: (row) => row.subRows,
    initialState: { pagination: { pageIndex: 0, pageSize: 50 } },
  });

  return (
    <>
      <RTable
        table={table}
        entity="product"
        ariaLabel="Products linked to this purchase"
        embedded
        isLoading={query.isPending}
        emptyState={
          <Empty variant="minimal" className="py-6">
            <EmptyHeader>
              <EmptyTitle>No products recorded</EmptyTitle>
              <EmptyDescription>
                No expense on this order names a product, and none has been
                attached directly. Attaching is most useful for lump-sum or
                installment orders whose expenses can&apos;t carry a product.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        }
      />
      {addToInventoryRow && (
        <ProductAddToInventoryDialog
          open
          onOpenChange={(open) => {
            if (!open) setAddToInventoryRow(null);
          }}
          product={addToInventoryRow}
        />
      )}
    </>
  );
}
