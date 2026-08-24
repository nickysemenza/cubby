import type {
  FinancialAccountFilters,
  FinancialAccountOut,
} from "@cubby/schemas/financial-account";
import { useMemo } from "react";
import { createCubbyColumnHelper } from "~/app/_components/data-table/table-features";
import { entities, entityDetailParams } from "~/entities/entities";
import { useTRPC } from "~/integrations/trpc/react";
import {
  createBooleanColumn,
  renderOptionCell,
} from "../_components/data-table/columnHelpers";
import { EntityListPage } from "../_components/data-table/EntityListPage";
import { useDeletableConfig } from "../_components/hooks/useDeletableConfig";
import { useUpdateMutation } from "../_components/hooks/useUpdateMutation";
import { TableLink } from "../_components/table/TableLink";
import {
  accountIdentityKindOptions,
  provisionalOptions,
} from "./financial-account-options";
export function FinancialAccountList() {
  const api = useTRPC();
  const helper = useMemo(
    () => createCubbyColumnHelper<FinancialAccountOut>(),
    [],
  );
  const deletable = useDeletableConfig({
    mutationFn: api.financialAccount.delete.mutationOptions,
    entity: "financialAccount",
  });
  const updateAccountMutation = useUpdateMutation({
    mutationFn: api.financialAccount.update.mutationOptions,
    entity: "financialAccount",
  });
  // biome-ignore lint/correctness/useExhaustiveDependencies: mutations change every render but are functionally stable
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
        cell: (i) =>
          renderOptionCell(i.getValue().kind, accountIdentityKindOptions),
      }),
      createBooleanColumn(helper, "provisional", {
        header: "Status",
        className: "w-28",
        // The same roster the detail page renders from, so the two cannot drift.
        trueFalseOptions: provisionalOptions,
        editable: {
          // `NOT NULL DEFAULT false`, so there is no undecided state to clear to
          // and `next` is only ever a boolean.
          onSave: async (provisional, account) => {
            await updateAccountMutation.mutateAsync({
              id: account.id,
              data: { provisional: provisional ?? false },
            });
          },
        },
      }),
      helper.accessor((r) => r.sourceAliases.length, {
        id: "aliases",
        header: "Aliases",
        meta: { numeric: true, className: "w-24" },
      }),
    ],
    [helper],
  );
  return (
    <EntityListPage<FinancialAccountOut, FinancialAccountFilters>
      entity="financialAccount"
      columns={columns}
      deletable={deletable}
      ariaLabel="Financial accounts"
      preview={false}
    />
  );
}
