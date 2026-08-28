import { expenseLineKindValues } from "@cubby/schemas/expense-line-kind";
import type { PurchaseShortcode } from "@cubby/schemas/identifiers";
import type { ExpenseFilters, ExpenseOut } from "@cubby/schemas/project";
import { useCallback, useMemo } from "react";

import {
  createProductLinkColumn,
  createProjectLinkColumn,
} from "~/app/_components/data-table/columnHelpers";
import { ListWorkbench } from "~/app/_components/data-table/ListWorkbench";
import { createCubbyColumnHelper } from "~/app/_components/data-table/table-features";
import { useDeletableConfig } from "~/app/_components/hooks/useDeletableConfig";
import { useEntityList } from "~/app/_components/hooks/useEntityList";
import { useNameEditable } from "~/app/_components/hooks/useNameEditable";
import type { ListQueryOptionsFn } from "~/app/_components/hooks/usePaginatedTableCore";
import { useUpdateMutation } from "~/app/_components/hooks/useUpdateMutation";
import {
  createExpenseProductImageColumn,
  ExpenseProductImages,
} from "~/app/expenses/expense-product-image-column";
import {
  expenseCostColumn,
  expenseCostTypeColumn,
  expenseDateColumn,
  expenseFutureColumn,
  expenseLineKindColumn,
  expenseProductQuantityColumn,
  expenseTradeColumn,
} from "~/app/projects/shared";
import { Stack } from "~/components/layout";
import { entityMutationOptionsFactory } from "~/entities/entity-contracts";
import { entityListFor } from "~/entities/entity-list.functions";

const EMBEDDED_TABLE_STATE = {
  initialSort: "date",
  urlSync: false,
  readUrlState: false,
  syncPaginationToUrl: false,
} as const;

/** Server-backed Expense list for one Purchase; Product is intentionally on. */
export function PurchaseExpensesTable({
  purchaseId,
}: {
  purchaseId: PurchaseShortcode;
}) {
  return (
    <Stack gap="lg">
      <PurchaseExpenseRows purchaseId={purchaseId} kind="principal" />
      <Stack gap="sm">
        <div>
          <h3 className="text-sm font-medium">Receipt adjustments</h3>
          <p className="text-xs text-muted-foreground">
            Tax, shipping, discounts, fees, and tips remain spend but are not
            assigned to cost-type or trade analytics.
          </p>
        </div>
        <PurchaseExpenseRows purchaseId={purchaseId} kind="adjustment" />
      </Stack>
    </Stack>
  );
}

function PurchaseExpenseRows({
  purchaseId,
  kind,
}: {
  purchaseId: PurchaseShortcode;
  kind: "principal" | "adjustment";
}) {
  const listQueryOptions: ListQueryOptionsFn<ExpenseFilters> = useCallback(
    (params) => entityListFor("expense").queryOptions(params),
    [],
  );
  const helper = useMemo(() => createCubbyColumnHelper<ExpenseOut>(), []);
  const scope = useMemo<Partial<ExpenseFilters>>(
    () => ({
      purchaseId,
      lineKind:
        kind === "principal"
          ? "principal"
          : expenseLineKindValues.filter((value) => value !== "principal"),
    }),
    [purchaseId, kind],
  );
  const update = useUpdateMutation({
    mutationFn: entityMutationOptionsFactory("expense", "update"),
    entity: "expense",
  });
  const nameEditable = useNameEditable<ExpenseOut>(update.mutateAsync);
  const deletable = useDeletableConfig({
    mutationFn: entityMutationOptionsFactory("expense", "delete"),
    entityLabel: "Expense",
    entity: "expense",
  });
  // biome-ignore lint/correctness/useExhaustiveDependencies: mutation wrappers are functionally stable
  const columns = useMemo(() => {
    const shared = [
      expenseCostColumn(
        helper,
        async (cost, row) => {
          await update.mutateAsync({ id: row.id, data: { cost } });
        },
        { signedTone: true },
      ),
      expenseDateColumn(helper, async (date, row) => {
        if (date === null) return;
        await update.mutateAsync({ id: row.id, data: { date } });
      }),
      expenseLineKindColumn(helper, async (lineKind, row) => {
        await update.mutateAsync({ id: row.id, data: { lineKind } });
      }),
      expenseFutureColumn(helper, async (future, row) => {
        await update.mutateAsync({ id: row.id, data: { future } });
      }),
      createProjectLinkColumn(helper, {
        className: "w-48",
        editable: {
          onSave: async (projectId, row) => {
            await update.mutateAsync({ id: row.id, data: { projectId } });
          },
        },
      }),
    ];
    if (kind === "adjustment") return shared;
    return [
      createExpenseProductImageColumn(helper),
      ...shared,
      expenseCostTypeColumn(helper, async (costType, row) => {
        await update.mutateAsync({ id: row.id, data: { costType } });
      }),
      expenseTradeColumn(helper, async (trade, row) => {
        await update.mutateAsync({ id: row.id, data: { trade } });
      }),
      createProductLinkColumn(helper, {
        className: "w-48",
        editable: {
          onSave: async (productId, row) => {
            await update.mutateAsync({ id: row.id, data: { productId } });
          },
        },
      }),
      expenseProductQuantityColumn(helper, async (productQuantity, row) => {
        await update.mutateAsync({
          id: row.id,
          data: { productQuantity },
        });
      }),
    ];
  }, [helper, kind]);
  const list = useEntityList<ExpenseOut, ExpenseFilters>({
    entity: "expense",
    queryOptions: listQueryOptions,
    scopeFilters: scope,
    columns,
    tableStateOptions: EMBEDDED_TABLE_STATE,
    layoutKey: `expense:purchase-detail:${kind}`,
    legacyLayoutVisibilityKey: `expense:purchase-detail-${kind}`,
    hiddenFilterColumns: ["vendor", "orderId"],
    deletable,
    nameEditable,
    initialColumnVisibility: {
      product: kind === "principal",
      productQuantity: kind === "principal",
      // A purchase can fund more than one project; keep the editable allocation
      // visible rather than hiding it behind the column menu.
      project: true,
      lineKind: kind === "adjustment",
      createdAt: false,
    },
  });
  const table = (
    <>
      <ListWorkbench
        model={list.workbench}
        ariaLabel={
          kind === "principal"
            ? "Purchase principal expenses"
            : "Purchase receipt adjustments"
        }
        mode="embedded"
        showColumnMenu
      />
    </>
  );
  return kind === "principal" ? (
    <ExpenseProductImages rows={list.data}>{table}</ExpenseProductImages>
  ) : (
    table
  );
}
