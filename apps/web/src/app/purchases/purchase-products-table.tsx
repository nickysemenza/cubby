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
    success: "Product removed from purchase",
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
      createActionsColumn(helper, "product", {
        extraActions: (row) => (
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
            <EmptyTitle>No products linked</EmptyTitle>
            <EmptyDescription>
              Attach the products this purchase bought — most useful for
              lump-sum or installment orders whose expenses can&apos;t carry a
              product.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      }
    />
  );
}
