import { useQuery } from "@tanstack/react-query";

import { Empty, EmptyDescription, EmptyTitle } from "~/components/ui/empty";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";
import { entities, entityDetailParams } from "~/entities/entities";
import {
  type EntityListParams,
  entityListFor,
} from "~/entities/entity-list.functions";
import { formatCurrency } from "~/lib/utils";

import { renderOptionCell } from "../_components/data-table/columnHelpers";
import { TableLink } from "../_components/table/TableLink";
import { financialTransactionStatusOptions } from "./financial-transaction-kind-options";

/** Compact linked-evidence table for account and Purchase detail plates. */
type FinancialTransactionListQuery = ReturnType<
  ReturnType<typeof entityListFor<"financialTransaction">>["queryOptions"]
>;

export interface LinkedTransactionsOperations {
  list: (
    params: EntityListParams<"financialTransaction">,
  ) => FinancialTransactionListQuery;
}

interface LinkedTransactionFilters {
  accountId?: string;
  purchaseId?: string;
}

const productionOperations: LinkedTransactionsOperations = {
  list: entityListFor("financialTransaction").queryOptions,
};

export function LinkedTransactions({
  accountId,
  purchaseId,
  operations = productionOperations,
}: {
  accountId?: string;
  purchaseId?: string;
  operations?: LinkedTransactionsOperations;
}) {
  const filters: LinkedTransactionFilters = {};
  if (accountId) filters.accountId = accountId;
  if (purchaseId) filters.purchaseId = purchaseId;
  const { data } = useQuery(
    operations.list({
      filters,
      pagination: { pageIndex: 0, pageSize: 100 },
    }),
  );
  const items = data?.items ?? [];
  if (items.length === 0)
    return (
      <Empty>
        <EmptyTitle>No linked transactions</EmptyTitle>
        <EmptyDescription>
          Settlement evidence can remain unmatched until there is one truthful
          Purchase to link.
        </EmptyDescription>
      </Empty>
    );
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-40">Transaction</TableHead>
          <TableHead className="w-32">Account</TableHead>
          <TableHead className="w-24">Status</TableHead>
          <TableHead className="w-24">Posted</TableHead>
          <TableHead className="w-36 text-right">Amount</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {items.map((transaction) => (
          <TableRow key={transaction.id}>
            <TableCell>
              <TableLink
                to={entities.financialTransaction.routes.detail}
                params={entityDetailParams(transaction.id)}
                className="block truncate"
                title={
                  transaction.merchant ||
                  transaction.rawDescription ||
                  transaction.id
                }
              >
                {transaction.merchant ||
                  transaction.rawDescription ||
                  transaction.id}
              </TableLink>
            </TableCell>
            <TableCell>
              <TableLink
                to={entities.financialAccount.routes.detail}
                params={entityDetailParams(transaction.accountId)}
                className="block truncate"
                title={transaction.accountName ?? transaction.accountId}
              >
                {transaction.accountName ?? transaction.accountId}
              </TableLink>
            </TableCell>
            <TableCell>
              {renderOptionCell(
                transaction.status,
                financialTransactionStatusOptions,
              )}
            </TableCell>
            <TableCell>{transaction.postedDate ?? "—"}</TableCell>
            <TableCell className="text-right font-mono tabular-nums">
              {/* Scoped to one purchase, the slice is the honest figure — the
                  full charge settled several orders, and showing it here would
                  overstate what this one received. The whole amount stays
                  visible beside it so the split is legible. */}
              {(() => {
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
              })()}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
