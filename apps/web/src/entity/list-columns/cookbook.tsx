import type { CookbookSummary } from "@cubby/schemas/recipe";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import { EntityRefLink } from "~/entity/components/entity-ref-link";
import {
  EntityDisplayImagesProvider,
  useEntityDisplayImage,
} from "~/entity/entity-media/entity-display-images";
import { cookbook } from "~/integrations/tanstack-query/generated/catalog.gen";
import { createNameColumn } from "~/ui/data-table/columnHelpers";
import {
  createCubbyColumnCollection,
  createCubbyColumnHelper,
  type CubbyColumnCollection,
} from "~/ui/data-table/table-features";
import { Row } from "~/ui/layout";
import { Badge } from "~/ui/primitives/badge";
import { NoneValue } from "~/ui/primitives/none-value";

import { defineListOverride } from "./types";

const columnHelper = createCubbyColumnHelper<CookbookSummary>();

const matchesCookbookSearch = (
  row: CookbookSummary,
  query: string,
): boolean => {
  const normalized = query.trim();
  if (!normalized) return true;
  return [row.id, row.book, ...row.author, ...row.subjects].some((value) =>
    value.toLocaleLowerCase().includes(normalized.toLocaleLowerCase()),
  );
};

function CookbookProductLink({
  product,
}: {
  product: NonNullable<CookbookSummary["product"]>;
}) {
  const displayImage = useEntityDisplayImage({
    entityKind: "product",
    entityId: product.id,
  });
  return (
    <EntityRefLink
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

/**
 * `subjects` is a text array, so TanStack would resolve a filterFn from the
 * array row value and match nothing against a picked set; a book matches when
 * it carries any picked subject.
 */
export const subjectsFilterFn = (
  row: { getValue: (id: string) => readonly string[] },
  columnId: string,
  picked: readonly string[] | undefined,
): boolean => {
  if (!picked || picked.length === 0) return true;
  const carried = row.getValue(columnId);
  return picked.some((subject) => carried.includes(subject));
};

/** Every subject in the loaded books, most-used first, with its book count. */
export const subjectOptions = (
  rows: readonly Pick<CookbookSummary, "subjects">[],
) => {
  const counts = new Map<string, number>();
  for (const row of rows)
    for (const subject of new Set(row.subjects))
      counts.set(subject, (counts.get(subject) ?? 0) + 1);
  return [...counts]
    .sort(([a, x], [b, y]) => y - x || a.localeCompare(b))
    .map(([subject, count]) => ({
      value: subject,
      label: subject,
      hint: String(count),
    }));
};

const composeWithSubjectFilter =
  (options: ReturnType<typeof subjectOptions>) =>
  (declared: CubbyColumnCollection<CookbookSummary>) =>
    createCubbyColumnCollection<CookbookSummary>((add) => {
      declared.visit((column) =>
        add(
          column.id === "subjects"
            ? {
                ...column,
                filterFn: subjectsFilterFn,
                meta: {
                  ...column.meta,
                  filterConfig: {
                    placeholder: "Filter by subject...",
                    filterType: "multiselect",
                    options,
                  },
                },
              }
            : column,
        ),
      );
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
      const { data, error, isFetching, isLoading, refetch } = query;
      const client = useMemo(
        () => ({
          data: data ?? EMPTY_COOKBOOKS,
          isLoading,
          error,
          refetch: async () => {
            await refetch();
          },
          isRefreshing: isFetching,
          matchesSearch: matchesCookbookSearch,
        }),
        [data, error, isFetching, isLoading, refetch],
      );
      const compose = useMemo(
        () => composeWithSubjectFilter(subjectOptions(data ?? EMPTY_COOKBOOKS)),
        [data],
      );
      return {
        overrides,
        compose,
        client,
        wrap: (children, { data }) => (
          <EntityDisplayImagesProvider
            refs={data.flatMap((row) =>
              row.product
                ? [{ entityKind: "product" as const, entityId: row.product.id }]
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
