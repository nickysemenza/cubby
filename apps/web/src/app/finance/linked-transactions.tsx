import type {
  FinancialTransactionFilters,
  FinancialTransactionOut,
} from "@cubby/schemas/financial-transaction";
import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import { PencilIcon } from "@phosphor-icons/react/dist/csr/Pencil";
import { PlusIcon } from "@phosphor-icons/react/dist/csr/Plus";
import { useCallback, useMemo } from "react";

import { createEntityDisplayColumns } from "~/entity/entity-display";
import { entityListFor } from "~/entity/entity-list";
import { formatCurrency } from "~/lib/utils";
import { ListWorkbench } from "~/ui/data-table/ListWorkbench";
import {
  createCubbyColumnCollection,
  createCubbyColumnHelper,
} from "~/ui/data-table/table-features";
import { useEntityList } from "~/ui/hooks/useEntityList";
import type { ListQueryOptionsFn } from "~/ui/hooks/usePaginatedTableCore";
import { useEntityFieldSave } from "~/ui/hooks/useUpdateMutation";
import { Row, Stack } from "~/ui/layout";
import { Button } from "~/ui/primitives/button";
import { Empty, EmptyDescription, EmptyTitle } from "~/ui/primitives/empty";

const EMBEDDED_TABLE_STATE = {
  initialSort: "postedDate",
  initialSortDesc: true,
  urlSync: false,
  readUrlState: false,
  syncPaginationToUrl: false,
} as const;

export interface LinkedTransactionsOperations {
  list: ListQueryOptionsFn<
    FinancialTransactionFilters,
    FinancialTransactionOut
  >;
}

const productionOperations: LinkedTransactionsOperations = {
  list: entityListFor("financialTransaction").listQueryPlan,
};

/**
 * The amount the purchase's section read gives a linked transaction: the slice this purchase
 * received, worded by the server ("$42.50 of $91.00" when the charge settled several orders).
 */
export type LinkedAmounts = ReadonlyMap<string, string>;

// Scoped to one purchase, the slice is the honest figure — the full charge
// settled several orders, and showing it here would overstate what this one
// received. The whole amount stays visible beside it so the split is legible.
// Where the server's section read supplies the slice (`amounts`), it is used as
// given; the allocation lookup below is only the fallback for a table without one.
function linkedTransactionAmount(
  transaction: FinancialTransactionOut,
  purchaseId: string | undefined,
  amounts?: LinkedAmounts,
) {
  const given = amounts?.get(transaction.id);
  if (given) return given;
  const slice = purchaseId
    ? transaction.allocations.find(
        (allocation) => allocation.purchaseId === purchaseId,
      )
    : undefined;
  if (!slice || transaction.allocations.length <= 1)
    return formatCurrency(transaction.amount);
  return (
    <>
      {formatCurrency(slice.amount)}
      <span className="ml-2 text-muted-foreground">
        of {formatCurrency(transaction.amount)}
      </span>
    </>
  );
}

/**
 * Server-backed linked-evidence ledger for account and Purchase detail plates.
 * Account detail already supplies the account context, so its rows omit that
 * redundant column while Purchase settlement keeps it available for comparison.
 */
export function LinkedTransactions({
  accountId,
  purchaseId,
  operations = productionOperations,
  onAddTransaction,
  onEditTransaction,
  amounts,
}: {
  accountId?: string;
  purchaseId?: string;
  /** The server-read amount for each transaction on this purchase. */
  amounts?: LinkedAmounts;
  operations?: LinkedTransactionsOperations;
  onAddTransaction?: () => void;
  onEditTransaction?: (transaction: FinancialTransactionOut) => void;
}) {
  const onSaveField = useEntityFieldSave("financialTransaction");
  const listQueryOptions = useCallback(
    (params: Parameters<LinkedTransactionsOperations["list"]>[0]) =>
      operations.list(params),
    [operations],
  );
  const helper = useMemo(
    () => createCubbyColumnHelper<FinancialTransactionOut>(),
    [],
  );
  const scope = useMemo<Partial<FinancialTransactionFilters>>(() => {
    const filters: Partial<FinancialTransactionFilters> = {};
    if (accountId) {
      filters.accountId = parseShortcodeFor("financialAccount", accountId);
    }
    if (purchaseId) {
      filters.purchaseId = parseShortcodeFor("purchase", purchaseId);
    }
    return filters;
  }, [accountId, purchaseId]);
  const columns = useMemo(
    () =>
      createCubbyColumnCollection<FinancialTransactionOut>((add) => {
        createEntityDisplayColumns(
          "financialTransaction",
          helper,
          createCubbyColumnCollection<FinancialTransactionOut>((override) =>
            override(
              helper.accessor("amount", {
                cell: (info) =>
                  linkedTransactionAmount(
                    info.row.original,
                    purchaseId,
                    amounts,
                  ),
              }),
            ),
          ),
          {
            only: [
              ...(accountId ? [] : ["accountId"]),
              "status",
              "postedDate",
              "amount",
            ],
            onSaveField,
          },
        ).visit(add);
        if (onEditTransaction) {
          add(
            helper.display({
              id: "editTransaction",
              header: "",
              enableSorting: false,
              meta: {
                className: "w-12",
                mobile: { slot: "actions", interactive: true },
              },
              cell: ({ row }) => (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Edit ${row.original.displayName}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    onEditTransaction(row.original);
                  }}
                >
                  <PencilIcon />
                </Button>
              ),
            }),
          );
        }
      }),
    [accountId, amounts, helper, onEditTransaction, onSaveField, purchaseId],
  );
  const list = useEntityList<
    FinancialTransactionOut,
    FinancialTransactionFilters
  >({
    entity: "financialTransaction",
    queryOptions: listQueryOptions,
    scopeFilters: scope,
    columns,
    nameClassName: "w-40",
    tableStateOptions: EMBEDDED_TABLE_STATE,
    includeCatalogActions: false,
    initialColumnVisibility: {
      "related:financialTransaction.vendor": false,
    },
  });

  return (
    <Stack gap="xs">
      {onAddTransaction ? (
        <Row justify="end">
          <Button type="button" size="sm" onClick={onAddTransaction}>
            <PlusIcon />
            Add transaction
          </Button>
        </Row>
      ) : null}
      <ListWorkbench
        model={list.workbench}
        ariaLabel="Linked transactions"
        mode="embedded"
        showColumnMenu
        emptyState={
          <Empty>
            <EmptyTitle>No linked transactions</EmptyTitle>
            <EmptyDescription>
              Settlement evidence can remain unmatched until there is one
              truthful Purchase to link.
            </EmptyDescription>
          </Empty>
        }
      />
    </Stack>
  );
}
