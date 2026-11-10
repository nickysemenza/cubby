import { fieldValueOf } from "@cubby/schemas/field-envelope";
import type { ExpenseAnalyzeReadyOut } from "@cubby/schemas/project";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";

import { EntityRefLink } from "~/entity/components/entity-ref-link";
import { RecordBucketLabel } from "~/entity/components/record-mark";
import type { ListRowOf } from "~/entity/display/list-renderer-types";
import { entityDetailFor } from "~/entity/entity-detail";
import { compileEntityListInput } from "~/entity/entity-list";
import { useEntityMetadata } from "~/entity/metadata";
import { ProductCategoryClassification } from "~/features/finance/spending-classification-review";
import { expense } from "~/integrations/tanstack-query/generated/domains/expense.gen";
import { formatCurrency } from "~/lib/number-format";
import { StaticTable } from "~/ui/data-table/static-table";
import { ErrorDisplay } from "~/ui/feedback/error-display";
import { Section, Stack } from "~/ui/layout";
import { Button } from "~/ui/primitives/button";
import { Description } from "~/ui/text/description";

type CategoryRow = ListRowOf<"productCategory"> & { subRows?: CategoryRow[] };

export function ProductCategoryConnections({ id }: { id: CategoryRow["id"] }) {
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
      {record.isPending && <Description>Loading category mapping…</Description>}
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
                <Link
                  className="underline underline-offset-4"
                  to="/products"
                  search={{ category: id, includeSubProductCategories: "true" }}
                >
                  {fieldValueOf(record.data.fields.productCount)}
                </Link>
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
        {analysis.error && (
          <ErrorDisplay
            error={analysis.error}
            onRetry={() => void analysis.refetch()}
          />
        )}
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
                      className="underline underline-offset-4"
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
      <Description>
        Historical review always includes all history, including planned. Table
        filters do not narrow the changes being reviewed.
      </Description>
      <Section title="Review mapping or parent change" headingAs="h3">
        {record.error && (
          <ErrorDisplay
            error={record.error}
            onRetry={() => void record.refetch()}
          />
        )}
        {record.data && <ProductCategoryClassification record={record.data} />}
      </Section>
    </Stack>
  );
}

export function ContributingCategories({
  bucket,
}: {
  bucket: Pick<ExpenseAnalyzeReadyOut["rows"][number], "label" | "filter">;
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
      {query.error && (
        <ErrorDisplay
          error={query.error}
          onRetry={() => void query.refetch()}
        />
      )}
      {query.isPending && (
        <Description>Loading contributing branches…</Description>
      )}
      {query.data?.status === "too_large" && (
        <Description>
          Contributing branches are unavailable because this report exceeds its
          limit.{" "}
          <Link
            className="underline underline-offset-4"
            to="/expenses"
            search={{ ...bucket.filter, view: "table" }}
          >
            Open this spending category in the Ledger.
          </Link>
        </Description>
      )}
      {data?.rows.length === 0 && (
        <Description>No booked spending in this scope.</Description>
      )}
      {data && (
        <StaticTable
          rows={data.rows}
          rowKey={(row) => row.key}
          columns={[
            {
              id: "productCategory",
              header: "Product category",
              cell: (row) => (
                <RecordBucketLabel
                  entity="productCategory"
                  id={row.key}
                  emoji={row.emoji}
                >
                  {row.label}
                </RecordBucketLabel>
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
                    className="underline underline-offset-4"
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
