import {
  type CookbookSummary,
  cookbookCoverImage,
} from "@cubby/schemas/recipe";
import { useSuspenseQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import {
  createActionsColumn,
  createImageColumn,
  createNameColumn,
} from "~/app/_components/data-table/columnHelpers";
import { ListWorkbench } from "~/app/_components/data-table/ListWorkbench";
import {
  createCubbyColumnCollection,
  createCubbyColumnHelper,
} from "~/app/_components/data-table/table-features";
import { useClientEntityList } from "~/app/_components/hooks/useClientEntityList";
import { Row } from "~/components/layout";
import { usePageCount } from "~/components/page/Page";
import { Badge } from "~/components/ui/badge";
import { cookbook } from "~/entities/cookbook.functions";

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
  const columns = useMemo(
    () =>
      createCubbyColumnCollection<CookbookSummary>((add) => {
        add(
          createImageColumn(columnHelper, {
            entity: "cookbook",
            // Falls back to the physical copy on the shelf: reading only
            // `row.coverUrl` placeholdered every cookbook whose sole photograph
            // lived on its linked Product.
            getImages: (row) => {
              const cover = cookbookCoverImage(row);
              return cover ? [{ id: row.id, url: cover }] : [];
            },
          }),
        );
        add(
          createNameColumn(columnHelper, "cookbook", "book", {
            header: "Title",
            emptyLabel: () => "Untitled",
            filterConfig: { placeholder: "Filter by title..." },
          }),
        );
        add(
          columnHelper.accessor((row) => row.author.join(", "), {
            id: "author",
            header: "Author",
            meta: {
              className: "w-48",
              mobile: { slot: "subtitle", priority: 10 },
            },
          }),
        );
        add(
          columnHelper.accessor("recipeCount", {
            id: "recipeCount",
            header: "Recipes",
            meta: {
              numeric: true,
              className: "w-32",
              mobile: { slot: "meta", priority: 20 },
            },
            // `sourceRecipeCount` is how many recipes the stored extraction
            // holds; `recipeCount` is how many have actually been imported.
            // Show the partial fraction while there are still recipes to
            // import, else a plain count once everything (or more) is in.
            //
            // A book stored in the retired format is called out here rather
            // than left to look merely under-imported: its source cannot be
            // read at all, so "12 / 40" would imply 28 recipes are one click
            // away when the only way back to them is a fresh extraction.
            cell: (info) => {
              const row = info.row.original;
              const allImported = row.sourceRecipeCount <= row.recipeCount;
              return (
                <Row as="span" align="center" justify="end" gap="xs">
                  <span className="tabular-nums">
                    {row.needsReextract || allImported
                      ? row.recipeCount
                      : `${row.recipeCount} / ${row.sourceRecipeCount}`}
                  </span>
                  {row.needsReextract && (
                    <Badge
                      variant="warning"
                      title="Extracted with a retired format — re-extract from the EPUB"
                    >
                      re-extract
                    </Badge>
                  )}
                </Row>
              );
            },
          }),
        );
        add(createActionsColumn(columnHelper, "cookbook"));
      }),
    [columnHelper],
  );

  const { workbench, inspection } = useClientEntityList<CookbookSummary>({
    entity: "cookbook",
    data: cookbooks,
    columns,
    preview: { responsiveInspector: true },
  });
  const {
    onRowClick,
    onRowHover,
    onRowHoverEnd,
    PreviewSheet,
    preview,
    dockedInspector,
    inspectorToggle,
  } = inspection;
  usePageCount(cookbooks.length);

  return (
    <>
      <ListWorkbench
        model={workbench}
        ariaLabel="Cookbooks Table"
        onRowClick={onRowClick}
        onRowHover={onRowHover}
        onRowHoverEnd={onRowHoverEnd}
        currentRowId={preview?.id}
        defaultDensity="dense"
        desktopInspector={dockedInspector}
        inspectorToggle={inspectorToggle}
      />
      <PreviewSheet />
    </>
  );
}
