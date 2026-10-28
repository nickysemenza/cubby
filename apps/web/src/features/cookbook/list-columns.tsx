import { type CookbookOut as CookbookSummary } from "@cubby/schemas/entities/cookbook";
import { fieldValueOf } from "@cubby/schemas/field-envelope";
import { useQuery } from "@tanstack/react-query";

import { EntityRefLink } from "~/entity/components/entity-ref-link";
import {
  EntityDisplayImagesProvider,
  useEntityDisplayImage,
} from "~/entity/entity-media/entity-display-images";
import { useFilterOptions } from "~/entity/hooks/use-filter-options";
import { cookbook } from "~/integrations/tanstack-query/domains/cookbook";
import {
  createCubbyColumnCollection,
  createCubbyColumnHelper,
} from "~/ui/data-table/table-features";
import { FieldRecordValue } from "~/ui/derived/record-value";
import { Row } from "~/ui/layout";
import { Badge } from "~/ui/primitives/badge";
import { NoneValue } from "~/ui/primitives/none-value";

import { defineListOverride } from "../../entity/list-columns/types";

const columnHelper = createCubbyColumnHelper<CookbookSummary>();

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
    />
  );
}

const overrides = createCubbyColumnCollection<CookbookSummary>((add) => {
  add(
    columnHelper.accessor((row) => fieldValueOf(row.fields.recipeCount), {
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
        const recipeCount = fieldValueOf(row.fields.recipeCount);
        const sourceRecipeCount = fieldValueOf(row.fields.sourceRecipeCount);
        const needsReextract = fieldValueOf(row.fields.needsReextract);
        const allImported =
          recipeCount !== null &&
          sourceRecipeCount !== null &&
          sourceRecipeCount <= recipeCount;
        return (
          <Row as="span" align="center" justify="end" gap="xs">
            <FieldRecordValue record={row} field="recipeCount">
              <span className="tabular-nums">
                {recipeCount === null ? (
                  <NoneValue />
                ) : needsReextract ||
                  allImported ||
                  sourceRecipeCount === null ? (
                  recipeCount
                ) : (
                  <>
                    {recipeCount} /{" "}
                    <FieldRecordValue record={row} field="sourceRecipeCount">
                      {sourceRecipeCount}
                    </FieldRecordValue>
                  </>
                )}
              </span>
            </FieldRecordValue>
            {needsReextract && (
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

/** Every subject across the household's books, most-used first, with its book count. */
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

/**
 * Browse-by-source index over the kernel list: search, sort, the subject
 * filter and paging run on the server. The subject picklist reads the full
 * cookbook roster the recipe pickers already share.
 */
export const cookbookListOverride = defineListOverride<CookbookSummary, object>(
  {
    use() {
      const { data } = useQuery(cookbook.list.queryOptions(null));
      const filterOptions = useFilterOptions({
        subjects: subjectOptions(data ?? EMPTY_COOKBOOKS),
      });
      return {
        overrides,
        list: { filterOptions },
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
