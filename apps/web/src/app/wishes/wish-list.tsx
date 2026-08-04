import type { WishFilters, WishOut } from "@cubby/schemas/wish";
import { createColumnHelper } from "@tanstack/react-table";
import { Plus } from "lucide-react";
import { useMemo, useState } from "react";
import RTable from "~/app/_components/data-table/Table";
import { useDeletableConfig } from "~/app/_components/hooks/useDeletableConfig";
import { useEntityList } from "~/app/_components/hooks/useEntityList";
import { usePageCount } from "~/components/page/Page";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { useTRPC } from "~/integrations/trpc/react";
import { wishMutationInvalidateKeys } from "~/lib/query-keys";
import { WishFormDialog } from "./wish-form-dialog";

export function WishList() {
  const api = useTRPC();
  const columnHelper = useMemo(() => createColumnHelper<WishOut>(), []);
  const [open, setOpen] = useState(false);

  const deletableConfig = useDeletableConfig({
    mutationFn: api.wish.delete.mutationOptions,
    entityLabel: "Wish",
    invalidateKeys: wishMutationInvalidateKeys,
    entity: "wish",
  });

  const columns = useMemo(
    () => [
      // `id: "acquired"` matches the `wish` filter manifest's boolean spec, so
      // the header filter control is picked up automatically — see
      // `useStandardColumns`' `withManifestFilter`.
      columnHelper.accessor((row) => row.acquiredAt, {
        id: "acquired",
        header: "Status",
        meta: { className: "w-28", mobile: { slot: "trailing", priority: 10 } },
        cell: (info) =>
          info.getValue() ? (
            <Badge variant="positive">Acquired</Badge>
          ) : (
            <Badge variant="slate">Wanted</Badge>
          ),
      }),
      columnHelper.accessor((row) => row.candidates.length, {
        id: "candidateCount",
        header: "Options",
        meta: {
          numeric: true,
          className: "w-24",
          mobile: { slot: "meta", priority: 20 },
        },
        cell: (info) => (
          <span className="font-mono tabular-nums">{info.getValue()}</span>
        ),
      }),
    ],
    [columnHelper],
  );

  // Neither `buildFilters` nor `filters` is passed: the `wish` entry in
  // `entities/filter-manifest.tsx` drives the Name search box, the server
  // `WishFilters` object, and the `?q=` URL round-trip.
  const {
    table,
    isLoading,
    error,
    timing,
    bulkActionBar,
    deleteDialog,
    infiniteScroll,
    refreshControls,
    totalCount,
  } = useEntityList<WishOut, WishFilters>({
    entity: "wish",
    queryOptions: api.wish.list.queryOptions,
    columns,
    deletable: deletableConfig,
  });
  usePageCount(totalCount);

  return (
    <div>
      <RTable
        table={table}
        isLoading={isLoading}
        error={error}
        ariaLabel="Wishlist Table"
        timing={timing}
        entity="wish"
        bulkActionBar={bulkActionBar}
        infiniteScroll={infiniteScroll}
        refreshControls={refreshControls}
        actions={
          <Button onClick={() => setOpen(true)}>
            <Plus /> New wish
          </Button>
        }
      />
      {deleteDialog}
      <WishFormDialog open={open} onOpenChange={setOpen} />
    </div>
  );
}
