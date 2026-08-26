import type { CookbookSummary } from "@cubby/schemas/recipe";
import { useSuspenseQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { VerbMenuItem } from "~/app/_components/actions/action-verb-ui";
import {
  createActionsColumn,
  createImageColumn,
  createNameColumn,
} from "~/app/_components/data-table/columnHelpers";
import { ListWorkbench } from "~/app/_components/data-table/ListWorkbench";
import { createCubbyColumnHelper } from "~/app/_components/data-table/table-features";
import { useClientEntityList } from "~/app/_components/hooks/useClientEntityList";
import { useEntityPreview } from "~/app/_components/hooks/useEntityPreview";
import { usePageCount } from "~/components/page/Page";
import { cookbook } from "~/entities/cookbook.functions";
import { useCookbookDelete } from "./use-cookbook-delete";

/**
 * Browse-by-source index: every cookbook a recipe was imported from, with its
 * author and recipe count. Backed by the Cookbook Start projection.
 * Each row links to the cookbook detail page, which lists that book's recipes.
 *
 * Client-paged like the other unpaginated small rosters — `listCookbooks`
 * returns the whole browse index in one shot, no server pagination to drive.
 */
export function CookbookList() {
  const columnHelper = useMemo(
    () => createCubbyColumnHelper<CookbookSummary>(),
    [],
  );
  const { data: cookbooks } = useSuspenseQuery(
    cookbook.list.queryOptions(null),
  );
  const { requestDelete, dialog } = useCookbookDelete();
  const { onRowClick, onRowHover, onRowHoverEnd, PreviewSheet } =
    useEntityPreview("cookbook");

  const columns = useMemo(
    () => [
      createImageColumn(columnHelper, {
        entity: "cookbook",
        getImages: (row) =>
          row.coverUrl ? [{ id: row.id, url: row.coverUrl }] : [],
      }),
      createNameColumn(columnHelper, "cookbook", "book", {
        header: "Title",
        emptyLabel: () => "Untitled",
        filterConfig: { placeholder: "Filter by title..." },
      }),
      columnHelper.accessor((row) => row.author.join(", "), {
        id: "author",
        header: "Author",
        meta: {
          className: "w-48",
          mobile: { slot: "subtitle", priority: 10 },
        },
      }),
      columnHelper.accessor("recipeCount", {
        id: "recipeCount",
        header: "Recipes",
        meta: {
          numeric: true,
          className: "w-32",
          mobile: { slot: "meta", priority: 20 },
        },
        // `sourceRecipeCount` is how many recipes the EPUB extraction holds;
        // `recipeCount` is how many have actually been imported. Show the
        // partial fraction while there are still recipes to import, else a
        // plain count once everything (or more) is in.
        cell: (info) => {
          const row = info.row.original;
          const allImported = row.sourceRecipeCount <= row.recipeCount;
          return (
            <span className="tabular-nums">
              {allImported
                ? row.recipeCount
                : `${row.recipeCount} / ${row.sourceRecipeCount}`}
            </span>
          );
        },
      }),
      createActionsColumn(columnHelper, "cookbook", {
        extraActions: (row) => (
          <VerbMenuItem
            verb="delete"
            onSelect={() =>
              requestDelete({
                id: row.id,
                name: row.book || "Untitled",
                recipeCount: row.recipeCount,
              })
            }
          />
        ),
      }),
    ],
    [columnHelper, requestDelete],
  );

  const { workbench } = useClientEntityList<CookbookSummary>({
    entity: "cookbook",
    data: cookbooks,
    columns,
  });
  usePageCount(cookbooks.length);

  return (
    <>
      <ListWorkbench
        model={workbench}
        ariaLabel="Cookbooks Table"
        onRowClick={onRowClick}
        onRowHover={onRowHover}
        onRowHoverEnd={onRowHoverEnd}
      />
      <PreviewSheet />
      {dialog}
    </>
  );
}
