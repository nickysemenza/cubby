import { spendingCategoryShortcode } from "@cubby/schemas/identifiers";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";

import { EntityRefLink } from "~/entity/components/entity-ref-link";
import type { ListRowOf } from "~/entity/display/list-renderer-types";
import { entityDetailFor } from "~/entity/entity-detail";
import { EntityRecordFields } from "~/entity/entity-detail/entity-record-fields";
import { listNested, nestSearchValue } from "~/entity/entity-list/list-nesting";
import type { EntityPreviewRendererProps } from "~/entity/hooks/use-entity-preview";
import { defineListOverride } from "~/entity/list-columns/types";
import type { EntityListParamsByEntity } from "~/entity/model/list-contracts";
import { CategorySpendingRemainders } from "~/features/finance/category-spending-remainders";
import { CategoryWorkspaceArrangement } from "~/features/finance/category-workspace-arrangement";
import {
  useCategoryContextTree,
  type CategoryContextRow,
} from "~/features/finance/use-category-context-tree";
import { useCategorySpending } from "~/features/finance/use-category-spending";
import { ContributingCategories } from "~/features/product-category/mapping-workspace";
import { formatCurrency } from "~/lib/number-format";
import {
  createCubbyColumnCollection,
  createCubbyColumnHelper,
  type CubbyColumnCollection,
} from "~/ui/data-table/table-features";
import { ErrorDisplay } from "~/ui/feedback/error-display";
import { Section, Stack } from "~/ui/layout";
import { SidePanel } from "~/ui/overlays/side-panel";
import { Description } from "~/ui/text/description";

type CategoryRow = ListRowOf<"spendingCategory">;
type CategoryTreeRow = CategoryContextRow<CategoryRow>;

function SpendingCategoryInspector({
  preview,
  onClose,
}: EntityPreviewRendererProps) {
  const id = spendingCategoryShortcode.parse(preview.id);
  const record = useQuery(entityDetailFor("spendingCategory").queryOptions(id));
  const bucket = useMemo(
    () => ({
      key: id,
      label: preview.name ?? "Spending category",
      filter: { spendingCategory: id, includeSubSpendingCategories: "true" },
    }),
    [id, preview.name],
  );
  const mappings = record.data ? (record.data.productCategories ?? []) : [];
  return (
    <SidePanel
      label="Spending category inspector"
      title={preview.name ?? "Spending category"}
      onClose={onClose}
    >
      <Stack gap="md" className="p-4">
        <Description>
          All history, including planned. Contributions include this category
          and its descendants.
        </Description>
        <ContributingCategories key={id} bucket={bucket} />
        <Section
          title="Configured incoming mappings"
          headingAs="h3"
          caption="Defaults configured for this category itself. Explicit Expense choices and merchant context can send money elsewhere."
        >
          {record.isPending && <Description>Loading category…</Description>}
          {record.error && (
            <ErrorDisplay
              error={record.error}
              onRetry={() => void record.refetch()}
            />
          )}
          {record.data &&
            (mappings.length ? (
              <ul className="space-y-2 text-sm">
                {mappings.map((mapping) => (
                  <li key={mapping.id}>
                    <EntityRefLink
                      entity="productCategory"
                      id={mapping.id}
                      name={mapping.name}
                    />{" "}
                    <span className="text-muted-foreground">
                      {mapping.inherited ? "Inherited" : "Set here"}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <Description>
                No Product Categories map directly or by inheritance to this
                category.
              </Description>
            ))}
        </Section>
        {record.data && (
          <Section title="Category and policies" headingAs="h3">
            <EntityRecordFields
              entity="spendingCategory"
              record={record.data}
              fields={[
                "name",
                "parentId",
                "itemizationExpectation",
                "productExpectation",
                "stockTracked",
              ]}
            />
          </Section>
        )}
      </Stack>
    </SidePanel>
  );
}
const PREVIEW = {
  responsiveInspector: true,
  mobileBehavior: "sheet",
  renderInspector: SpendingCategoryInspector,
} as const;
const VISIBILITY = {
  dataQuality: false,
  productCategories: false,
  itemizationExpectation: false,
  productExpectation: false,
};

export const spendingCategoryListOverride = defineListOverride<
  CategoryTreeRow,
  EntityListParamsByEntity["spendingCategory"]["filters"],
  CategoryRow
>({
  use(context) {
    const client = useQueryClient();
    const nested = listNested(client, "spendingCategory", context.search);
    const spending = useCategorySpending("spendingCategory");
    const hierarchy = useCategoryContextTree(spending.records, nested);
    const compose = useMemo(
      () => (declared: CubbyColumnCollection<CategoryTreeRow>) =>
        createCubbyColumnCollection<CategoryTreeRow>((add) => {
          declared.visit(add);
          const helper = createCubbyColumnHelper<CategoryTreeRow>();
          add(
            helper.accessor((row) => row.productCategories?.length ?? 0, {
              id: "incomingMappings",
              header: "Mappings",
              enableSorting: false,
              meta: { provenance: null, numeric: true },
              cell: ({ getValue }) => getValue(),
            }),
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
                    ? spending.isLoading
                      ? "Loading…"
                      : "Unavailable"
                    : `${formatCurrency(getValue() ?? 0)}${spending.totals?.incomplete.has(row.original.id) ? " + unknown" : ""}`,
              },
            ),
          );
        }),
      [spending.totals, spending.isLoading],
    );
    const list = useMemo(
      () => ({
        preview: PREVIEW,
        initialColumnVisibility: VISIBILITY,
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
          <CategoryWorkspaceArrangement
            nested={nested}
            onChange={(value) =>
              context.navigate(
                { nest: nestSearchValue(client, "spendingCategory", value) },
                { replace: true },
              )
            }
          />
          <Description>
            All history, including planned. Net spending includes descendants.
            Mappings counts configured Product Categories for each category
            itself.
          </Description>
          {spending.error && (
            <ErrorDisplay
              error={spending.error}
              onRetry={() => void spending.refetch()}
            />
          )}
          {spending.status === "too_large" && (
            <Description>
              Spending is unavailable because the report exceeds its limit.
            </Description>
          )}
        </>
      ),
      below: () => <CategorySpendingRemainders entity="spendingCategory" />,
    };
  },
});
