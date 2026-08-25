import type { PurchaseFilters, PurchaseOut } from "@cubby/schemas/purchase";
import type { VendorOut } from "@cubby/schemas/vendor";
import { useCallback, useMemo } from "react";
import {
  createCurrencyColumn,
  createPlainDateColumn,
  createTextColumn,
} from "~/app/_components/data-table/columnHelpers";
import { EditableCell } from "~/app/_components/data-table/editable-cell";
import { ListWorkbench } from "~/app/_components/data-table/ListWorkbench";
import { createCubbyColumnHelper } from "~/app/_components/data-table/table-features";
import { useEntityList } from "~/app/_components/hooks/useEntityList";
import type { ListQueryOptionsFn } from "~/app/_components/hooks/usePaginatedTableCore";
import { useUpdateMutation } from "~/app/_components/hooks/useUpdateMutation";
import { OrderIdLink } from "~/app/_components/OrderIdLink";
import { TableLink } from "~/app/_components/table/TableLink";
import { Row } from "~/components/layout";
import { NoneValue } from "~/components/ui/none-value";
import { entities, entityDetailParams } from "~/entities/entities";
import { entityMutationOptionsFactory } from "~/entities/entity-contracts";
import { entityListQueryOptions } from "~/entities/entity-list.functions";
import { purchaseIdentityLabel } from "~/lib/purchase-label";
import { formatCurrency } from "~/lib/utils";

const EMBEDDED_TABLE_STATE = {
  initialSort: "date",
  urlSync: false,
  readUrlState: false,
  syncPaginationToUrl: false,
} as const;

/**
 * Server-backed purchase roster scoped to one vendor. Related Expense and
 * Financial transaction columns come from the shared graph-preview registry,
 * so this table and the global Purchase list render and filter them identically.
 */
export function VendorPurchasesTable({ vendor }: { vendor: VendorOut }) {
  const listQueryOptions: ListQueryOptionsFn<PurchaseFilters> = useCallback(
    (params) => entityListQueryOptions("purchase", params),
    [],
  );
  const helper = useMemo(() => createCubbyColumnHelper<PurchaseOut>(), []);
  const scope = useMemo<Partial<PurchaseFilters>>(
    () => ({ vendorId: vendor.id }),
    [vendor.id],
  );
  const update = useUpdateMutation({
    mutationFn: entityMutationOptionsFactory("purchase", "update"),
    entity: "purchase",
  });
  // biome-ignore lint/correctness/useExhaustiveDependencies: mutation wrapper is functionally stable
  const columns = useMemo(
    () => [
      createPlainDateColumn(helper, "date", {
        header: "Date",
        editable: {
          onSave: async (date, purchase) => {
            if (date === null) return;
            await update.mutateAsync({ id: purchase.id, data: { date } });
          },
        },
      }),
      helper.display({
        id: "purchase",
        header: "Purchase",
        meta: { className: "w-56" },
        cell: (info) => (
          <TableLink
            to={entities.purchase.routes.detail}
            params={entityDetailParams(info.row.original.id)}
            className="block truncate"
          >
            {purchaseIdentityLabel(info.row.original)}
          </TableLink>
        ),
      }),
      createTextColumn(helper, "orderId", {
        header: "Order #",
        className: "w-40 font-mono",
        // Pencil trigger so the link icon beside the id is clickable without
        // the surrounding cell swallowing the click into the inline editor.
        trigger: "pencil",
        renderValue: (v, purchase) =>
          v ? (
            <Row align="center" gap="xs">
              <span className="min-w-0 truncate">{v}</span>
              <OrderIdLink
                orderUrl={purchase.orderUrl}
                orderId={v}
                vendorName={purchase.vendorName}
              />
            </Row>
          ) : (
            <NoneValue />
          ),
        editable: {
          onSave: async (orderId, purchase) => {
            await update.mutateAsync({ id: purchase.id, data: { orderId } });
          },
        },
      }),
      createTextColumn(helper, "displayLabel", {
        header: "Display label",
        placeholder: "e.g. pocket hole jig + bits",
        className: "w-56",
        editable: {
          onSave: async (displayLabel, purchase) => {
            await update.mutateAsync({
              id: purchase.id,
              data: { displayLabel },
            });
          },
        },
      }),
      helper.accessor("expenseCount", {
        header: "Expense count",
        meta: { numeric: true, className: "w-24" },
      }),
      // Paperwork total is a per-order reconciliation cue, never spend; do
      // not use createCurrencyColumn because that factory renders a sum footer.
      helper.accessor("statedTotal", {
        header: "Stated",
        meta: { numeric: true, className: "w-24" },
        cell: (info) => (
          <EditableCell
            value={info.getValue()}
            config={{ type: "currency" }}
            onSave={async (statedTotal) => {
              const purchase = info.row.original;
              await update.mutateAsync({
                id: purchase.id,
                data: { statedTotal },
              });
            }}
            renderValue={(statedTotal) =>
              statedTotal == null ? <NoneValue /> : formatCurrency(statedTotal)
            }
          />
        ),
      }),
      createCurrencyColumn(helper, "expenseTotal", {
        header: "Expense total",
        className: "w-28",
      }),
    ],
    [helper],
  );
  const list = useEntityList<PurchaseOut, PurchaseFilters>({
    entity: "purchase",
    queryOptions: listQueryOptions,
    scopeFilters: scope,
    columns,
    tableStateOptions: EMBEDDED_TABLE_STATE,
    layoutKey: "purchase:vendor-detail",
    hiddenFilterColumns: ["vendor"],
  });

  return (
    <ListWorkbench
      model={list.workbench}
      ariaLabel={`${vendor.name} purchases`}
      mode="embedded"
      showColumnMenu
      emptyState={<NoneValue />}
    />
  );
}
