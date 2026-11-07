import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";

import { expense } from "~/integrations/tanstack-query/generated/domains/expense.gen";
import { formatCurrency } from "~/lib/number-format";
import { ErrorDisplay } from "~/ui/feedback/error-display";
import { Section } from "~/ui/layout";
import { Description } from "~/ui/text/description";

/** Remainders are disjoint allocation buckets, never synthetic category nodes. */
export function CategorySpendingRemainders({
  entity,
}: {
  entity: "productCategory" | "spendingCategory";
}) {
  const query = useQuery(
    expense.analyze.queryOptions({
      filters: {},
      rowDimension: entity,
      spendingCategoryRollup: entity === "spendingCategory" ? "root" : "none",
    }),
  );
  const data = query.data?.status === "ready" ? query.data : undefined;
  const remainders =
    data?.rows.filter(
      (row) =>
        row.key.startsWith("__") ||
        row.key === "uncategorized" ||
        row.key === "unclassified",
    ) ?? [];
  return (
    <Section
      id="category-spending-coverage"
      title="Spending coverage"
      headingAs="h3"
      caption="All history, including planned. This household-wide coverage is unchanged by the category display filters."
    >
      {query.isPending && <Description>Loading spending coverage…</Description>}
      {query.error && (
        <ErrorDisplay
          error={query.error}
          onRetry={() => void query.refetch()}
        />
      )}
      {query.data?.status === "too_large" && (
        <Description>
          Coverage exceeds the report limit. Open the Ledger to narrow the
          scope.
        </Description>
      )}
      {data && (
        <>
          <Description>
            <Link to="/expenses" search={{ view: "table" }}>
              All booked net:{" "}
              {formatCurrency(
                Math.round(data.totals.scope.current.net * 100) / 100,
              )}
              {data.totals.scope.current.unpricedCount ? " + unknown" : ""}
            </Link>
            . Parent totals include their children and must not be added
            together.
          </Description>
          {remainders.length ? (
            <ul className="space-y-1 text-sm">
              {remainders.map((row) => {
                const value = data.cells.find(
                  (cell) => cell.rowKey === row.key,
                )?.current;
                return (
                  <li key={row.key}>
                    <Link
                      to="/expenses"
                      search={{ ...row.filter, view: "table" }}
                    >
                      {row.label} · {formatCurrency(value?.net ?? 0)}
                      {value?.unpricedCount ? " + unknown" : ""}
                    </Link>
                  </li>
                );
              })}
            </ul>
          ) : (
            <Description>
              No spending without category detail in this scope.
            </Description>
          )}
        </>
      )}
    </Section>
  );
}
