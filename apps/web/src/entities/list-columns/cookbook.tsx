import type { CookbookSummary } from "@cubby/schemas/recipe";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import {
  createImageColumn,
  createNameColumn,
} from "~/app/_components/data-table/columnHelpers";
import {
  createCubbyColumnCollection,
  createCubbyColumnHelper,
  type CubbyColumnCollection,
} from "~/app/_components/data-table/table-features";
import {
  EntityDisplayImagesProvider,
  useEntityDisplayImage,
} from "~/app/_components/entity-media/entity-display-images";
import { EntityInlineLink } from "~/app/_components/EntityInlineLink";
import { Row } from "~/components/layout";
import { Badge } from "~/components/ui/badge";
import { NoneValue } from "~/components/ui/none-value";
import { cookbook } from "~/entities/cookbook.functions";
import { relationshipFieldProvenance } from "~/entities/field-provenance";

import { defineListOverride } from "./types";

const columnHelper = createCubbyColumnHelper<CookbookSummary>();

function CookbookProductLink({
  product,
}: {
  product: NonNullable<CookbookSummary["product"]>;
}) {
  const displayImage = useEntityDisplayImage({
    entityType: "product",
    entityId: product.id,
  });
  return (
    <EntityInlineLink
      displayImage={displayImage}
      entity="product"
      data={product}
      compact
    />
  );
}

const overrides = createCubbyColumnCollection<CookbookSummary>((add) => {
  // The declared column is `name` (read key `book`); the name column keeps
  // its `book` accessor under the declared id.
  add({
    ...createNameColumn(columnHelper, "cookbook", "book", {
      header: "Title",
      emptyLabel: () => "Untitled",
      filterConfig: { placeholder: "Filter by title..." },
    }),
    id: "name",
  });
  add(
    columnHelper.accessor("recipeCount", {
      id: "recipeCount",
      header: "Recipes",
      meta: {
        numeric: true,
        className: "w-32",
        mobile: { slot: "meta", priority: 20 },
      },
      // `sourceRecipeCount` is how many recipes the stored extraction holds;
      // `recipeCount` how many are imported. A book in the retired format is
      // called out rather than left to look under-imported: its source cannot
      // be read, so "12 / 40" would imply 28 recipes are one click away.
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
  add({
    ...createImageColumn(columnHelper, {
      entity: "cookbook",
      provenance: relationshipFieldProvenance("cookbook", "cover"),
    }),
    id: "coverUrl",
  });
  add(
    columnHelper.accessor((row) => row.product?.name ?? null, {
      id: "product",
      header: "Physical copy",
      enableSorting: false,
      meta: { className: "w-56", mobile: { slot: "meta", priority: 40 } },
      cell: (info) => {
        const product = info.row.original.product;
        return product ? (
          <CookbookProductLink product={product} />
        ) : (
          <NoneValue />
        );
      },
    }),
  );
});

const compose = (declared: CubbyColumnCollection<CookbookSummary>) =>
  createCubbyColumnCollection<CookbookSummary>((add) => {
    // Cover first, as the other image-led rosters read.
    declared.filter((column) => column.id === "coverUrl").visit(add);
    declared.filter((column) => column.id !== "coverUrl").visit(add);
  });

/**
 * Browse-by-source index: every cookbook a recipe was imported from. Backed
 * by the Cookbook Start projection — one shot, no server pagination — so the
 * generic list pages it client-side.
 */
export const cookbookListOverride = defineListOverride<CookbookSummary, object>(
  {
    mode: "client",
    use() {
      const query = useQuery(cookbook.list.queryOptions(null));
      const client = useMemo(
        () => ({
          data: query.data ?? EMPTY_COOKBOOKS,
          isLoading: query.isLoading,
          error: query.error,
        }),
        [query.data, query.isLoading, query.error],
      );
      return {
        overrides,
        compose,
        client,
        wrap: (children, { data }) => (
          <EntityDisplayImagesProvider
            refs={data.flatMap((row) =>
              row.product
                ? [{ entityType: "product" as const, entityId: row.product.id }]
                : [],
            )}
          >
            {children}
          </EntityDisplayImagesProvider>
        ),
      };
    },
  },
);

const EMPTY_COOKBOOKS: CookbookSummary[] = [];
