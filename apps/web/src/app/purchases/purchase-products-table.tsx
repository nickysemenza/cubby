import type { PurchaseProductOut } from "@cubby/schemas/purchase";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
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
import { Badge } from "~/components/ui/badge";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "~/components/ui/empty";
import { useTRPC } from "~/integrations/trpc/react";
import { isUnspecifiedManufacturer } from "~/lib/manufacturer-utils";
import { purchaseProductMutationInvalidateKeys } from "~/lib/query-keys";

const EMPTY_PRODUCTS: PurchaseProductOut[] = [];

type PurchaseProductRow = {
  id: string;
  name: string;
  manufacturer: string;
  price: number | null;
  /** An explicit `PurchaseProduct` row exists — the only detachable case. */
  linked: boolean;
  images: Array<{ id: string; url: string; filename: string }>;
};

export function PurchaseProductsTable({ purchaseId }: { purchaseId: string }) {
  const api = useTRPC();
  const query = useQuery(api.purchase.products.queryOptions({ purchaseId }));
  const items = query.data ?? EMPTY_PRODUCTS;
  const rows = useMemo<PurchaseProductRow[]>(
    () =>
      items.map((item) => ({
        id: item.productId,
        name: item.productName,
        manufacturer: item.manufacturer,
        price: item.price,
        linked: item.linkAttachedAt !== null,
        images: item.coverImageUrl
          ? [
              {
                id: `cover:${item.productId}`,
                url: item.coverImageUrl,
                filename: item.productName,
              },
            ]
          : [],
      })),
    [items],
  );
  const detach = useActionMutation({
    mutationFn: api.purchase.detachProducts.mutationOptions,
    // See the twin in `product-purchases.tsx`: detaching clears the explicit
    // link only, and an expense-backed row stays listed.
    success: "Link removed — any itemized expense still relates these",
    invalidateKeys: purchaseProductMutationInvalidateKeys,
  });
  const helper = useMemo(
    () => createCubbyColumnHelper<PurchaseProductRow>(),
    [],
  );
  const columns = useMemo<CubbyColumnDef<PurchaseProductRow>[]>(
    () => [
      createImageColumn(helper, { entity: "product" }),
      createNameColumn(helper, "product", "name", { header: "Product" }),
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
        extraActions: (row) =>
          !row.linked ? null : (
            <VerbMenuItem
              verb="removeFromPurchase"
              disabled={detach.isPending}
              onSelect={(event) => {
                event.stopPropagation();
                detach.mutate({ purchaseId, productIds: [row.id] });
              }}
            />
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
    getRowId: (row) => row.id,
    initialState: { pagination: { pageIndex: 0, pageSize: 50 } },
  });

  return (
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
  );
}
