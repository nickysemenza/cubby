import {
  financialTransactionStatus,
  type FinancialTransactionOut,
  type FinancialTransactionStatus,
} from "@cubby/schemas/financial-transaction";
import type { ReactNode } from "react";

import {
  createFilterableSelectColumn,
  createPlainDateColumn,
} from "~/app/_components/data-table/columnHelpers";
import type { CubbyColumnHelper } from "~/app/_components/data-table/table-features";
import { TableLink } from "~/app/_components/table/TableLink";
import { entities, entityDetailParams } from "~/entities/entities";
import { formatCurrency } from "~/lib/utils";

import { financialTransactionStatusOptions } from "./financial-transaction-kind-options";

export function createFinancialTransactionAccountColumn(
  helper: CubbyColumnHelper<FinancialTransactionOut>,
  className = "w-40",
) {
  return helper.accessor("accountId", {
    header: "Account",
    meta: {
      className,
      mobile: { slot: "subtitle", priority: 10, interactive: true },
    },
    cell: (info) => {
      const transaction = info.row.original;
      const label = transaction.accountName ?? transaction.accountId;
      return (
        <TableLink
          to={entities.financialAccount.routes.detail}
          params={entityDetailParams(transaction.accountId)}
          className="block truncate"
          title={label}
        >
          {label}
        </TableLink>
      );
    },
  });
}

export function createFinancialTransactionStatusColumn(
  helper: CubbyColumnHelper<FinancialTransactionOut>,
  options: {
    className?: string;
    onSave?: (
      status: FinancialTransactionStatus,
      transaction: FinancialTransactionOut,
    ) => Promise<void>;
  } = {},
) {
  return createFilterableSelectColumn(helper, "status", {
    header: "Status",
    placeholder: "Filter by status...",
    selectOptions: financialTransactionStatusOptions,
    className: options.className ?? "w-24",
    mobile: {
      slot: "meta",
      priority: 20,
      interactive: options.onSave !== undefined,
    },
    filterConfig: null,
    editable: options.onSave
      ? {
          parseValue: (value) => financialTransactionStatus.parse(value),
          onSave: options.onSave,
        }
      : undefined,
  });
}

export function createFinancialTransactionPostedDateColumn(
  helper: CubbyColumnHelper<FinancialTransactionOut>,
  className = "w-28",
) {
  return createPlainDateColumn(helper, "postedDate", {
    header: "Posted",
    className,
    mobile: { slot: "meta", priority: 30 },
  });
}

export function createFinancialTransactionAmountColumn(
  helper: CubbyColumnHelper<FinancialTransactionOut>,
  options: {
    className?: string;
    render?: (transaction: FinancialTransactionOut) => ReactNode;
  } = {},
) {
  return helper.accessor("amount", {
    header: "Amount",
    meta: {
      numeric: true,
      className: options.className ?? "w-28",
      mobile: { slot: "trailing", priority: 1 },
    },
    cell: (info) =>
      options.render?.(info.row.original) ?? formatCurrency(info.getValue()),
  });
}
