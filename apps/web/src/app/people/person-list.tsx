import type { PersonFilters, PersonOut } from "@cubby/schemas/person";
import { useMemo } from "react";
import { ListWorkbench } from "~/app/_components/data-table/ListWorkbench";
import { createCubbyColumnHelper } from "~/app/_components/data-table/table-features";
import { useDeletableConfig } from "~/app/_components/hooks/useDeletableConfig";
import { useEntityList } from "~/app/_components/hooks/useEntityList";
import { TableLink } from "~/app/_components/table/TableLink";
import { entities, entityDetailParams } from "~/entities/entities";
import { useTRPC } from "~/integrations/trpc/react";
import { personMutationInvalidateKeys } from "~/lib/query-keys";

export function PersonList() {
  const api = useTRPC();
  const helper = useMemo(() => createCubbyColumnHelper<PersonOut>(), []);
  const deletable = useDeletableConfig({
    mutationFn: api.person.delete.mutationOptions,
    entityLabel: "Person",
    entity: "person",
    invalidateKeys: personMutationInvalidateKeys,
  });
  const columns = useMemo(
    () => [
      helper.accessor("name", {
        header: "Person",
        meta: { className: "w-64", mobile: { slot: "title", priority: 0 } },
        cell: (info) => (
          <TableLink
            to={entities.person.routes.detail}
            params={entityDetailParams(info.row.original.id)}
            className="block truncate"
          >
            {info.getValue()}
          </TableLink>
        ),
      }),
      helper.accessor("kind", { header: "Kind", meta: { className: "w-28" } }),
      helper.accessor("linkedUser", {
        header: "Login",
        meta: { className: "w-64" },
        cell: (info) => info.getValue()?.email ?? "—",
      }),
    ],
    [helper],
  );
  const list = useEntityList<PersonOut, PersonFilters>({
    entity: "person",
    queryOptions: api.person.list.queryOptions,
    columns,
    deletable,
  });
  return <ListWorkbench model={list.workbench} ariaLabel="People" />;
}
