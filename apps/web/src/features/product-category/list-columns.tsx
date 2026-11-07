import { productCategoryShortcode } from "@cubby/schemas/identifiers";
import { useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";

import { EntityRefLink } from "~/entity/components/entity-ref-link";
import type { ListRowOf } from "~/entity/display/list-renderer-types";
import { listNested } from "~/entity/entity-list/list-nesting";
import type { EntityPreviewRendererProps } from "~/entity/hooks/use-entity-preview";
import { defineListOverride } from "~/entity/list-columns/types";
import type { EntityListParamsByEntity } from "~/entity/model/list-contracts";
import { CategorySpendingRemainders } from "~/features/finance/category-spending-remainders";
import {
  useCategoryContextTree,
  type CategoryContextRow,
} from "~/features/finance/use-category-context-tree";
import { useCategorySpending } from "~/features/finance/use-category-spending";
import { ProductCategoryConnections } from "~/features/product-category/mapping-workspace";
import { formatCurrency } from "~/lib/number-format";
import {
  createCubbyColumnCollection,
  createCubbyColumnHelper,
  type CubbyColumnCollection,
} from "~/ui/data-table/table-features";
import { ErrorDisplay } from "~/ui/feedback/error-display";
import { SidePanel } from "~/ui/overlays/side-panel";
import { Description } from "~/ui/text/description";

type CategoryRow = ListRowOf<"productCategory">;
type CategoryTreeRow = CategoryContextRow<CategoryRow>;

function ProductCategoryInspector({
  preview,
  onClose,
}: EntityPreviewRendererProps) {
  const id = productCategoryShortcode.parse(preview.id);
  return (
    <SidePanel
      label="Category mapping inspector"
      title={preview.name ?? "Product category"}
      onClose={onClose}
    >
      <div className="p-4">
        <ProductCategoryConnections key={id} id={id} />
      </div>
    </SidePanel>
  );
}

const PREVIEW = {
  responsiveInspector: true,
  mobileBehavior: "sheet",
  renderInspector: ProductCategoryInspector,
} as const;

export const productCategoryListOverride = defineListOverride<
  CategoryTreeRow,
  EntityListParamsByEntity["productCategory"]["filters"],
  CategoryRow
>({
  use(context) {
    const client = useQueryClient();
    const nested = listNested(client, "productCategory", context.search);
    const spending = useCategorySpending("productCategory");
    const hierarchy = useCategoryContextTree(spending.records, nested);
    const compose = useMemo(
      () => (declared: CubbyColumnCollection<CategoryTreeRow>) =>
        createCubbyColumnCollection<CategoryTreeRow>((add) => {
          declared.visit(add);
          const helper = createCubbyColumnHelper<CategoryTreeRow>();
          add(
            helper.accessor(
              (row) => row.spendingCategoryMapping?.state ?? "unmapped",
              {
                id: "mappingSource",
                header: "Mapping source",
                enableSorting: false,
                meta: {
                  provenance: null,
                  mobile: { slot: "meta", priority: 10 },
                },
                cell: ({ row }) => {
                  const mapping = row.original.spendingCategoryMapping;
                  if (mapping?.state === "direct") return "Set here";
                  if (mapping?.source)
                    return (
                      <span>
                        {mapping.state === "blocked"
                          ? "Blocked at"
                          : "Inherited from"}{" "}
                        <EntityRefLink
                          entity="productCategory"
                          id={mapping.source.id}
                          name={mapping.source.name}
                        />
                      </span>
                    );
                  return mapping?.state === "blocked" ? "Blocked" : "Missing";
                },
              },
            ),
          );
          add(
            helper.accessor(
              (row) =>
                spending.totals
                  ? (spending.totals.cents.get(row.id) ?? 0) / 100
                  : null,
              {
                id: "subtreeNet",
                header: "Subtree net",
                enableSorting: false,
                meta: {
                  provenance: null,
                  numeric: true,
                  mobile: { slot: "trailing", priority: 10 },
                },
                cell: ({ getValue, row }) =>
                  getValue() === null
                    ? "Unavailable"
                    : `${formatCurrency(getValue() ?? 0)}${spending.totals?.incomplete.has(row.original.id) ? " + unknown" : ""}`,
              },
            ),
          );
        }),
      [spending.totals],
    );
    const list = useMemo(
      () => ({
        preview: PREVIEW,
        nameSuffix: (row: CategoryTreeRow) =>
          row.categoryContext ? (
            <span className="text-xs text-muted-foreground">Ancestor</span>
          ) : null,
      }),
      [],
    );
    return {
      compose,
      list,
      tree: hierarchy.tree,
      useWorkbench: hierarchy.useWorkbench,
      above: () => (
        <>
          <Description>
            All history, including planned. Products and net spending include
            descendants; parent totals already include their children. Ancestor
            rows provide context and are excluded from selection. Table filters
            change visible categories, not historical review scope.
          </Description>
          {spending.error && <ErrorDisplay error={spending.error} />}
          {spending.status === "too_large" && (
            <Description>
              Spending is unavailable because the report exceeds its limit.
            </Description>
          )}
        </>
      ),
      below: () => <CategorySpendingRemainders entity="productCategory" />,
    };
  },
});
