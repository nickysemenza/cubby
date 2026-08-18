import type { KitMembershipOut } from "@cubby/schemas/product-components";
import type { ProductPurchaseOut } from "@cubby/schemas/purchase";
import { useQuery } from "@tanstack/react-query";
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
  useCubbyTable,
} from "~/app/_components/data-table/table-features";
import { useCubbyTableLayout } from "~/app/_components/data-table/table-layout";
import { EntityInlineLink } from "~/app/_components/EntityInlineLink";
import { useActionMutation } from "~/app/_components/hooks/useActionMutation";
import { Badge } from "~/components/ui/badge";
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
    // Not "removed from purchase": detaching clears only the explicit link, and
    // a row that also has an itemized Expense stays right where it is, now
    // reading `source: "expense"`. Claiming removal would be a lie on exactly
    // the rows where the distinction matters.
    success: "Link removed — any itemized expense still relates these",
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
      // Badge the rare case, not the common one. Nearly every row here is
      // derived from an itemized Expense; the explicit `PurchaseProduct` link
      // is the exception (13 in the whole ledger) and the only detachable one,
      // so it is what earns a marker.
      helper.accessor((row) => row.linkAttachedAt !== null, {
        id: "link",
        header: "",
        // A blank header MUST also disable sorting. The sort control renders as
        // a button labelled by the header text, so an empty one is a button
        // with no accessible name — a `serious` Axe violation that fails the
        // accessibility smoke E2E. Same pairing as the `url` column in
        // `expenses/expenselist.tsx`.
        enableSorting: false,
        meta: {
          className: "w-24",
          mobile: { slot: "meta", priority: 30 },
        },
        cell: (info) =>
          info.getValue() ? <Badge variant="outline">Linked</Badge> : null,
      }),
      createActionsColumn(helper, "purchase", {
        // Only an explicit link can be detached. An expense-derived row has no
        // `PurchaseProduct` row to remove, and offering the verb there would
        // "succeed" (detach is a no-op on a missing pair) while the row stayed
        // on screen. To break that relation you edit the Expense's product.
        extraActions: (row) =>
          row.linkAttachedAt === null ? null : (
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
  const layout = useCubbyTableLayout({ key: "product:purchases", columns });
  const table = useCubbyTable({
    data: rows,
    columns: layout.columns,
    atoms: layout.atoms,
    meta: { defaultLayout: layout.defaultLayout },
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
        <EmptyTitle>No purchases recorded</EmptyTitle>
        <EmptyDescription>
          No expense on this product names an order, and no order has been
          linked to it directly. Record the spend on an expense, or attach it
          from a purchase&apos;s Products section when the order was never
          itemized.
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  );

  return (
    <RTable
      table={table}
      entity="purchase"
      ariaLabel="Purchases linked to this product"
      embedded
      isLoading={
        query.isPending || (items.length === 0 && membershipQuery.isPending)
      }
      emptyState={emptyState}
    />
  );
}
