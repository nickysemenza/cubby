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
import { useTRPC } from "~/integrations/trpc/react";
import { formatCurrency } from "~/lib/utils";
import { TableLink } from "../_components/table/TableLink";

/** Compact linked-evidence table for account and Purchase detail plates. */
export function LinkedTransactions({
  accountId,
  purchaseId,
}: {
  accountId?: string;
  purchaseId?: string;
}) {
  const api = useTRPC();
  const { data } = useQuery(
    api.financialTransaction.list.queryOptions({
      filters: {
        ...(accountId ? { accountId } : {}),
        ...(purchaseId ? { purchaseId } : {}),
      },
      pagination: { pageSize: 100 },
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
          <TableHead>Transaction</TableHead>
          <TableHead>Account</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Posted</TableHead>
          <TableHead className="text-right">Amount</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {items.map((transaction) => (
          <TableRow key={transaction.id}>
            <TableCell>
              <TableLink
                to={entities.financialTransaction.routes.detail}
                params={entityDetailParams(transaction.id)}
              >
                {transaction.merchant ||
                  transaction.rawDescription ||
                  transaction.id}
              </TableLink>
            </TableCell>
            <TableCell>
              {transaction.accountName ?? transaction.accountId}
            </TableCell>
            <TableCell>{transaction.status}</TableCell>
            <TableCell>{transaction.postedDate ?? "—"}</TableCell>
            <TableCell className="text-right font-mono tabular-nums">
              {formatCurrency(transaction.amount)}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
