import type { KitMembershipOut } from "@cubby/schemas/product-components";
import type { ProductPurchaseOut } from "@cubby/schemas/purchase";
import { useQuery } from "@tanstack/react-query";
import { useTable } from "@tanstack/react-table";
import { format } from "date-fns";
import { useMemo } from "react";
import { VerbMenuItem } from "~/app/_components/actions/action-verb-ui";
import {
  createActionsColumn,
  createNameColumn,
} from "~/app/_components/data-table/columnHelpers";
import RTable from "~/app/_components/data-table/Table";
import {
  type CubbyColumnDef,
  createCubbyColumnHelper,
  cubbyTableFeatures,
} from "~/app/_components/data-table/table-features";
import { EntityInlineLink } from "~/app/_components/EntityInlineLink";
import { useActionMutation } from "~/app/_components/hooks/useActionMutation";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "~/components/ui/empty";
import { useTRPC } from "~/integrations/trpc/react";
import { parsePlainDate } from "~/lib/plain-date";
import { purchaseLabel } from "~/lib/purchase-label";
import { purchaseProductMutationInvalidateKeys } from "~/lib/query-keys";

const EMPTY_PURCHASES: ProductPurchaseOut[] = [];
const EMPTY_MEMBERSHIP: KitMembershipOut[] = [];
type PurchaseRow = ProductPurchaseOut & { id: string; name: string };

export function ProductPurchases({ productId }: { productId: string }) {
  const api = useTRPC();
  const query = useQuery(api.product.purchases.queryOptions({ productId }));
  const items = query.data ?? EMPTY_PURCHASES;
  // Only consulted when `items` is empty (below) — a component of a kit is
  // never itself attached to a purchase, so the generic "attach this
  // product" advice is not just unhelpful there, it's wrong: attaching would
  // reintroduce the per-component modelling that was deliberately removed in
  // favor of the kit carrying one Expense.
  const membershipQuery = useQuery(
    api.product.kitMembership.queryOptions({ productId }),
  );
  const membership = membershipQuery.data ?? EMPTY_MEMBERSHIP;
  const rows = useMemo<PurchaseRow[]>(
    () =>
      items.map((item) => ({
        ...item,
        id: item.purchaseId,
        name: purchaseLabel(item),
      })),
    [items],
  );
  const detach = useActionMutation({
    mutationFn: api.purchase.detachProducts.mutationOptions,
    success: "Removed from purchase",
    invalidateKeys: purchaseProductMutationInvalidateKeys,
  });
  const helper = useMemo(() => createCubbyColumnHelper<PurchaseRow>(), []);
  const columns = useMemo<CubbyColumnDef<PurchaseRow>[]>(
    () => [
      createNameColumn(helper, "purchase", "name", { header: "Purchase" }),
      helper.accessor((row) => row.vendorName, {
        id: "vendor",
        header: "Vendor",
        meta: {
          className: "w-40",
          mobile: { slot: "subtitle", priority: 10 },
        },
      }),
      helper.accessor((row) => row.date, {
        id: "date",
        header: "Date",
        meta: {
          className: "w-32",
          mono: true,
          mobile: { slot: "meta", priority: 20 },
        },
        cell: (info) => format(parsePlainDate(info.getValue()), "MMM d, yyyy"),
      }),
      createActionsColumn(helper, "purchase", {
        extraActions: (row) => (
          <VerbMenuItem
            verb="removeFromPurchase"
            disabled={detach.isPending}
            onSelect={(event) => {
              event.stopPropagation();
              detach.mutate({ purchaseId: row.id, productIds: [productId] });
            }}
          />
        ),
      }),
    ],
    [detach, helper, productId],
  );
  const table = useTable<typeof cubbyTableFeatures, PurchaseRow>({
    features: cubbyTableFeatures,
    data: rows,
    columns,
    getRowId: (row) => row.id,
    initialState: { pagination: { pageIndex: 0, pageSize: 50 } },
  });
  const [primaryKit, ...restKits] = membership;
  const emptyState = primaryKit ? (
    <Empty variant="minimal" className="py-6">
      <EmptyHeader>
        <EmptyTitle>No purchases of its own</EmptyTitle>
        <EmptyDescription>
          This product is a component of{" "}
          <EntityInlineLink
            entity="product"
            data={{
              id: primaryKit.parentProductId,
              name: primaryKit.parentProductName,
              manufacturer: primaryKit.manufacturer,
            }}
            compact
          />
          {restKits.length > 0 &&
            ` (and ${restKits.length} other kit${restKits.length === 1 ? "" : "s"})`}
          . Attaching this product to an order directly would misrepresent it as
          bought on its own — the kit&apos;s own order is the real one.
        </EmptyDescription>
      </EmptyHeader>
      {primaryKit.purchase && (
        <EntityInlineLink
          entity="purchase"
          data={{
            id: primaryKit.purchase.purchaseId,
            orderId: primaryKit.purchase.orderId,
            displayLabel: primaryKit.purchase.displayLabel,
            vendorName: primaryKit.purchase.vendorName,
            date: primaryKit.purchase.date,
          }}
        />
      )}
    </Empty>
  ) : (
    <Empty variant="minimal" className="py-6">
      <EmptyHeader>
        <EmptyTitle>No purchases linked</EmptyTitle>
        <EmptyDescription>
          Attach this product from a purchase&apos;s Products section to record
          which order it came from.
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  );

  return (
    <RTable
      table={table}
      entity="purchase"
      ariaLabel="Purchases linked to this product"
      sizingKey="product:purchases"
      embedded
      isLoading={
        query.isPending || (items.length === 0 && membershipQuery.isPending)
      }
      emptyState={emptyState}
    />
  );
}
