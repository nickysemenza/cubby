import { fieldValueOf } from "@cubby/schemas/field-envelope";
import type { ExpenseAnalyzeReadyOut } from "@cubby/schemas/project";
import { CaretRightIcon } from "@phosphor-icons/react/dist/csr/CaretRight";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";

import { EntityRefLink } from "~/entity/components/entity-ref-link";
import type { ListRowOf } from "~/entity/display/list-renderer-types";
import { entityDetailFor } from "~/entity/entity-detail";
import { compileEntityListInput } from "~/entity/entity-list";
import { useServerTree } from "~/entity/hooks/use-server-tree";
import { useEntityMetadata } from "~/entity/metadata";
import { createImageColumn } from "~/entity/table/column-helpers";
import RTable from "~/entity/table/table";
import { ProductCategoryClassification } from "~/features/finance/spending-classification-review";
import { expense } from "~/integrations/tanstack-query/generated/domains/expense.gen";
import { formatCurrency } from "~/lib/number-format";
import { useTableColumnLayout } from "~/ui/data-table/column-layout";
import { StaticTable } from "~/ui/data-table/static-table";
import {
  createCubbyColumnCollection,
  createCubbyColumnHelper,
  useCubbyTable,
} from "~/ui/data-table/table-features";
import { ErrorDisplay } from "~/ui/feedback/error-display";
import { Section, Stack } from "~/ui/layout";
import { SidePanel } from "~/ui/overlays/side-panel";
import { Button } from "~/ui/primitives/button";
import { Description } from "~/ui/text/description";

type CategoryRow = ListRowOf<"productCategory"> & { subRows?: CategoryRow[] };
const EMPTY_ROWS: CategoryRow[] = [];
const ALL_HISTORY = { filters: {}, rowDimension: "productCategory" } as const;

/** Own-category amounts are disjoint; roll up cents, never ancestor counts. */
function subtreeCents(
  rows: readonly CategoryRow[],
  analysis: ExpenseAnalyzeReadyOut | undefined,
) {
  const own = new Map<string, number>();
  const incomplete = new Set<string>();
  for (const cell of analysis?.cells ?? []) {
    if (cell.current.unpricedCount > 0) incomplete.add(cell.rowKey);
    own.set(
      cell.rowKey,
      (own.get(cell.rowKey) ?? 0) + Math.round(cell.current.net * 100),
    );
  }
  const totals = new Map<string, number>();
  const visit = (row: CategoryRow): number => {
    const cents =
      (own.get(row.id) ?? 0) +
      (row.subRows?.reduce((sum, child) => sum + visit(child), 0) ?? 0);
    totals.set(row.id, cents);
    if (row.subRows?.some((child) => incomplete.has(child.id)))
      incomplete.add(row.id);
    return cents;
  };
  rows.forEach(visit);
  return { totals, incomplete };
}

function SelectedCategory({ id }: { id: CategoryRow["id"] }) {
  const [destination, setDestination] = useState<
    ExpenseAnalyzeReadyOut["rows"][number] | null
  >(null);
  const record = useQuery(entityDetailFor("productCategory").queryOptions(id));
  const analysisInput = useMemo(
    () => ({
      filters: { productCategoryId: [id], includeSubProductCategories: true },
      rowDimension: "spendingCategory" as const,
      spendingCategoryRollup: "root" as const,
    }),
    [id],
  );
  const analysis = useQuery(expense.analyze.queryOptions(analysisInput));
  const data = analysis.data?.status === "ready" ? analysis.data : undefined;
  const mapping = record.data?.spendingCategoryMapping;
  return (
    <Stack gap="md">
      {record.data && (
        <Section title="Configured mapping" headingAs="h3">
          <dl className="space-y-2 text-sm">
            <div>
              <dt className="text-muted-foreground">Effective spending</dt>
              <dd>
                {mapping?.category ? (
                  <EntityRefLink
                    entity="spendingCategory"
                    id={mapping.category.id}
                    name={mapping.category.name}
                  />
                ) : mapping?.state === "blocked" ? (
                  "Blocked"
                ) : (
                  "Missing"
                )}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Mapping source</dt>
              <dd>
                {mapping?.state === "direct" ? (
                  "Set here"
                ) : mapping?.source ? (
                  <>
                    {mapping.state === "blocked"
                      ? "Blocked at"
                      : "Inherited from"}{" "}
                    <EntityRefLink
                      entity="productCategory"
                      id={mapping.source.id}
                      name={mapping.source.name}
                    />
                  </>
                ) : (
                  "No mapping in this branch"
                )}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Products in this branch</dt>
              <dd className="tabular-nums">
                {fieldValueOf(record.data.fields.productCount)}
              </dd>
            </div>
          </dl>
        </Section>
      )}
      <Section
        headingAs="h3"
        title="Where this branch's money lands"
        caption="All history, including planned. Actual allocations can differ from the configured mapping."
      >
        {analysis.error && <ErrorDisplay error={analysis.error} />}
        {analysis.isPending && (
          <Description>Loading spending allocations…</Description>
        )}
        {analysis.data?.status === "too_large" && (
          <Description>
            This branch exceeds the report limit. Select a narrower category.
          </Description>
        )}
        {data && (
          <StaticTable
            rows={data.rows}
            rowKey={(row) => row.key}
            columns={[
              {
                id: "category",
                header: "Spending category",
                cell: (row) => (
                  <Button variant="ghost" onClick={() => setDestination(row)}>
                    {row.label}
                  </Button>
                ),
              },
              {
                id: "net",
                header: "Net",
                headClassName: "text-right",
                cellClassName: "text-right tabular-nums",
                cell: (row) => {
                  const current = data.cells.find(
                    (cell) => cell.rowKey === row.key,
                  )?.current;
                  return (
                    <Link
                      to="/expenses"
                      search={{
                        productCategory: id,
                        includeSubProductCategories: "true",
                        ...row.filter,
                        view: "table",
                      }}
                    >
                      {formatCurrency(current?.net ?? 0)}
                      {current?.unpricedCount ? " + unknown" : ""}
                    </Link>
                  );
                },
              },
            ]}
          />
        )}
      </Section>
      {destination && <ContributingCategories bucket={destination} />}
      <Section title="Review mapping or parent change" headingAs="h3">
        {record.error && <ErrorDisplay error={record.error} />}
        {record.data && <ProductCategoryClassification record={record.data} />}
      </Section>
    </Stack>
  );
}

function ContributingCategories({
  bucket,
}: {
  bucket: ExpenseAnalyzeReadyOut["rows"][number];
}) {
  const client = useQueryClient();
  useEntityMetadata("expense");
  const input = useMemo(() => {
    return {
      filters: compileEntityListInput(client, "expense", bucket.filter).filters,
      rowDimension: "productCategory" as const,
    };
  }, [bucket.filter, client]);
  const query = useQuery(expense.analyze.queryOptions(input));
  const data = query.data?.status === "ready" ? query.data : undefined;
  return (
    <Section
      headingAs="h3"
      title={`Contributing branches · ${bucket.label}`}
      caption="All product branches for this spending category, including entries without product detail."
    >
      {query.error && <ErrorDisplay error={query.error} />}
      {query.isPending && (
        <Description>Loading contributing branches…</Description>
      )}
      {query.data?.status === "too_large" && (
        <Description>
          Contributing branches are unavailable because this report exceeds its
          limit.{" "}
          <Link to="/expenses" search={{ ...bucket.filter, view: "table" }}>
            Open this spending category in the Ledger.
          </Link>
        </Description>
      )}
      {data && (
        <StaticTable
          rows={data.rows}
          rowKey={(row) => row.key}
          columns={[
            {
              id: "productCategory",
              header: "Product category",
              cell: (row) => row.label,
            },
            {
              id: "net",
              header: "Net",
              headClassName: "text-right",
              cellClassName: "text-right tabular-nums",
              cell: (row) => {
                const current = data.cells.find(
                  (cell) => cell.rowKey === row.key,
                )?.current;
                return (
                  <Link
                    to="/expenses"
                    search={{ ...bucket.filter, ...row.filter, view: "table" }}
                  >
                    {formatCurrency(current?.net ?? 0)}
                    {current?.unpricedCount ? " + unknown" : ""}
                  </Link>
                );
              },
            },
          ]}
        />
      )}
    </Section>
  );
}

/** A complete hierarchy keeps ancestor context during local table search. */
export function CategoryMappingWorkspace() {
  const client = useQueryClient();
  useEntityMetadata("productCategory");
  const input = useMemo(
    () =>
      compileEntityListInput(
        client,
        "productCategory",
        {},
        { defaultSort: { orderBy: "sortOrder", direction: "asc" } },
      ),
    [client],
  );
  const categories = useServerTree("productCategory", input);
  const analysis = useQuery(expense.analyze.queryOptions(ALL_HISTORY));
  const rows = categories.tree ?? EMPTY_ROWS;
  const analysisData =
    analysis.data?.status === "ready" ? analysis.data : undefined;
  const cents = useMemo(
    () => subtreeCents(rows, analysisData),
    [rows, analysisData],
  );
  const [selected, setSelected] = useState<CategoryRow | null>(null);
  const columns = useMemo(() => {
    const helper = createCubbyColumnHelper<CategoryRow>();
    return createCubbyColumnCollection<CategoryRow>((add) => {
      add(createImageColumn(helper, { entity: "productCategory" }));
      add(
        helper.accessor("name", {
          header: "Product category",
          filterFn: "includesString",
          meta: { entityColumnRole: "identity", mobile: { slot: "title" } },
          cell: ({ row }) => (
            <div
              className="flex items-center gap-1"
              style={{ paddingInlineStart: row.depth * 12 }}
            >
              <Button
                variant="ghost"
                size="icon-sm"
                disabled={!row.getCanExpand()}
                aria-label={`${row.getIsExpanded() ? "Collapse" : "Expand"} ${row.original.name}`}
                aria-expanded={
                  row.getCanExpand() ? row.getIsExpanded() : undefined
                }
                onClick={row.getToggleExpandedHandler()}
              >
                <CaretRightIcon
                  className={
                    row.getIsExpanded() ? "size-3 rotate-90" : "size-3"
                  }
                />
              </Button>
              <EntityRefLink
                entity="productCategory"
                id={row.original.id}
                name={row.original.name}
                bare
              />
            </div>
          ),
        }),
      );
      add(
        helper.accessor(
          (row) =>
            row.spendingCategoryMapping?.category?.name ??
            (row.spendingCategoryMapping?.state === "blocked"
              ? "Blocked"
              : "Missing"),
          {
            id: "mapping",
            header: "Effective spending",
            meta: { mobile: { slot: "subtitle", priority: 10 } },
            cell: ({ row }) => {
              const mapping = row.original.spendingCategoryMapping;
              return mapping?.category ? (
                <EntityRefLink
                  entity="spendingCategory"
                  id={mapping.category.id}
                  name={mapping.category.name}
                />
              ) : (
                <span className="text-muted-foreground">
                  {mapping?.state === "blocked" ? "Blocked" : "Missing"}
                </span>
              );
            },
          },
        ),
      );
      add(
        helper.accessor(
          (row) => row.spendingCategoryMapping?.state ?? "unmapped",
          {
            id: "source",
            header: "Mapping source",
            meta: { mobile: { slot: "meta", priority: 20 } },
            cell: ({ row }) => {
              const mapping = row.original.spendingCategoryMapping;
              if (mapping?.state === "direct") return "Set here";
              if (mapping?.source)
                return (
                  <span>
                    {mapping.state === "blocked"
                      ? "Blocked at "
                      : "Inherited from "}
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
        helper.accessor((row) => fieldValueOf(row.fields.productCount), {
          id: "products",
          header: "Products",
          meta: { numeric: true, mobile: { slot: "meta", priority: 30 } },
        }),
      );
      add(
        helper.accessor(
          (row) =>
            analysisData ? (cents.totals.get(row.id) ?? 0) / 100 : null,
          {
            id: "net",
            header: "Subtree net",
            meta: { numeric: true, mobile: { slot: "trailing", priority: 10 } },
            cell: ({ getValue, row }) =>
              getValue() === null
                ? "Unavailable"
                : `${formatCurrency(getValue() ?? 0)}${cents.incomplete.has(row.original.id) ? " + unknown" : ""}`,
          },
        ),
      );
    });
  }, [analysisData, cents]);
  const { columns: tableColumns, defaultLayout } = useTableColumnLayout({
    columns,
  });
  const table = useCubbyTable({
    data: rows,
    columns: tableColumns,
    getRowId: (row) => row.id,
    getSubRows: (row) => row.subRows,
    filterFromLeafRows: true,
    initialState: {
      expanded: true,
      columnOrder: defaultLayout.columnOrder,
      columnVisibility: defaultLayout.columnVisibility,
      columnPinning: defaultLayout.columnPinning,
    },
    meta: {
      defaultLayout,
      primarySearch: { key: "name", placeholder: "Find a category or branch…" },
      completeLocalData: true,
    },
    enableCellSelection: false,
  });
  return (
    <Stack gap="sm">
      <Description>
        All history, including planned. Product counts and net spending include
        descendants. A mapping is a default; explicit Expense choices and
        merchant context can change where money lands.
      </Description>
      {analysis.error && <ErrorDisplay error={analysis.error} />}
      {analysis.data?.status === "too_large" && (
        <Description>
          Spending is unavailable because this report exceeds its limit.
        </Description>
      )}
      <RTable
        table={table}
        ariaLabel="Product category mappings"
        isLoading={categories.isLoading}
        error={categories.error}
        onRowClick={(row) => setSelected(row.original)}
        currentRowId={selected?.id}
        inspector={
          selected
            ? {
                title: selected.name,
                content: (
                  <SidePanel
                    label="Category mapping inspector"
                    title={selected.name}
                    onClose={() => setSelected(null)}
                  >
                    <div className="p-4">
                      <SelectedCategory key={selected.id} id={selected.id} />
                    </div>
                  </SidePanel>
                ),
                onClose: () => setSelected(null),
              }
            : undefined
        }
      />
      {analysisData && (
        <Section
          headingAs="h3"
          title="Spending without product-category detail"
          caption="These amounts remain in the Ledger and spending reports, outside the product-category tree."
        >
          <StaticTable
            rows={analysisData.rows.filter((row) => row.key.startsWith("__"))}
            rowKey={(row) => row.key}
            columns={[
              { id: "reason", header: "Reason", cell: (row) => row.label },
              {
                id: "net",
                header: "Net",
                headClassName: "text-right",
                cellClassName: "text-right tabular-nums",
                cell: (row) => {
                  const current = analysisData.cells.find(
                    (cell) => cell.rowKey === row.key,
                  )?.current;
                  return (
                    <Link
                      to="/expenses"
                      search={{ ...row.filter, view: "table" }}
                    >
                      {formatCurrency(current?.net ?? 0)}
                      {current?.unpricedCount ? " + unknown" : ""}
                    </Link>
                  );
                },
              },
            ]}
          />
          <Description>
            Ledger net: {formatCurrency(analysisData.totals.scope.current.net)}
            {analysisData.totals.scope.current.unpricedCount
              ? " plus unknown amounts"
              : ""}
            . Parent amounts include their children; do not add them together.
          </Description>
        </Section>
      )}
    </Stack>
  );
}
