import type {
  FinancialAccountFilters,
  FinancialAccountOut,
} from "@cubby/schemas/financial-account";
import { createColumnHelper } from "@tanstack/react-table";
import { useMemo } from "react";
import { Badge } from "~/components/ui/badge";
import { entities, entityDetailParams } from "~/entities/entities";
import { useTRPC } from "~/integrations/trpc/react";
import { financialAccountMutationInvalidateKeys } from "~/lib/query-keys";
import RTable from "../_components/data-table/Table";
import { useDeletableConfig } from "../_components/hooks/useDeletableConfig";
import { useEntityList } from "../_components/hooks/useEntityList";
import { TableLink } from "../_components/table/TableLink";
export function FinancialAccountList() {
  const api = useTRPC();
  const helper = useMemo(() => createColumnHelper<FinancialAccountOut>(), []);
  const deletable = useDeletableConfig({
    mutationFn: api.financialAccount.delete.mutationOptions,
    entityLabel: "Account",
    entity: "financialAccount",
    invalidateKeys: financialAccountMutationInvalidateKeys,
  });
  const columns = useMemo(
    () => [
      helper.accessor("name", {
        header: "Account",
        meta: { className: "w-64", mobile: { slot: "title", priority: 0 } },
        cell: (i) => (
          <TableLink
            to={entities.financialAccount.routes.detail}
            params={entityDetailParams(i.row.original.id)}
            className="block truncate"
          >
            {i.getValue()}
          </TableLink>
        ),
      }),
      helper.accessor("identity", {
        header: "Identity",
        meta: { className: "w-40" },
        cell: (i) => i.getValue().kind.replaceAll("_", " "),
      }),
      helper.accessor("provisional", {
        header: "Status",
        meta: { className: "w-28" },
        cell: (i) =>
          i.getValue() ? (
            <Badge variant="warning">Provisional</Badge>
          ) : (
            <Badge variant="positive">Known</Badge>
          ),
      }),
      helper.accessor((r) => r.sourceAliases.length, {
        id: "aliases",
        header: "Aliases",
        meta: { numeric: true, className: "w-24" },
      }),
    ],
    [helper],
  );
  const list = useEntityList<FinancialAccountOut, FinancialAccountFilters>({
    entity: "financialAccount",
    queryOptions: api.financialAccount.list.queryOptions,
    columns,
    deletable,
  });
  return (
    <>
      <RTable
        table={list.table}
        isLoading={list.isLoading}
        error={list.error}
        timing={list.timing}
        entity="financialAccount"
        ariaLabel="Financial accounts"
        bulkActionBar={list.bulkActionBar}
        infiniteScroll={list.infiniteScroll}
        refreshControls={list.refreshControls}
      />
      {list.deleteDialog}
    </>
  );
}
