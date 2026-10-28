import type { ExpenseMonthlyAggregate } from "@cubby/schemas/project";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useId, useMemo } from "react";

import { expense } from "~/integrations/tanstack-query/domains/expense";
import { formatCalendarDay } from "~/lib/date-format";
import { formatCount, formatCurrency } from "~/lib/number-format";
import { cn } from "~/lib/utils";
import { CurrencyValue } from "~/ui/common/currency-value";
import { EmptyState } from "~/ui/feedback/empty-state";
import { ErrorDisplay } from "~/ui/feedback/error-display";
import { Section } from "~/ui/layout";

import { getHomeAsOfWindow, type HomeAsOfWindow } from "./home-as-of-window";
import { HomeList, HomeRow, HomeRowsLoading } from "./home-list";

export function fillRecordedSpendMonths(
  monthly: ExpenseMonthlyAggregate[],
  months: string[],
): ExpenseMonthlyAggregate[] {
  const byMonth = new Map(monthly.map((row) => [row.month, row]));
  return months.map(
    (month) =>
      byMonth.get(month) ?? {
        month,
        actual: 0,
        committed: 0,
        credits: 0,
        net: 0,
        count: 0,
      },
  );
}

/** Backwards-compatible projection used by the focused home-signal checks. */
export function getRecordedSpendWindow(now: Date) {
  return getHomeAsOfWindow(now).spend;
}

export function describeRecordedSpendChange(
  current: ExpenseMonthlyAggregate | undefined,
  previous: ExpenseMonthlyAggregate | undefined,
) {
  if (!current) return "No current month-to-date total.";
  if (!previous) {
    return `${formatCurrency(current.net)} month-to-date; no prior calendar month to compare.`;
  }
  return `${formatCurrency(current.net)} month-to-date; prior calendar month was ${formatCurrency(previous.net)}.`;
}

/**
 * Six complete/current calendar months of recorded household spend. This is a
 * focused home read over the ledger's existing SQL aggregate, never a second
 * client-side total and never Purchase.statedTotal. The strip and the rail
 * share it.
 */
export function useRecordedSpend(asOf: HomeAsOfWindow) {
  const query = useQuery(
    expense.monthlySummary.queryOptions(asOf.spend.filters),
  );
  const monthly = useMemo(
    () =>
      query.data === undefined
        ? undefined
        : fillRecordedSpendMonths(query.data, asOf.spend.months),
    [asOf.spend.months, query.data],
  );
  return { query, monthly };
}

/** Home's Money rail: each recent month's recorded spend, newest first. */
export function HomeMoney({ asOf }: { asOf: HomeAsOfWindow }) {
  const summaryId = useId();
  const { query, monthly } = useRecordedSpend(asOf);
  const current = monthly?.at(-1);
  return (
    <Section
      title="Money"
      headingAs="h2"
      ruled
      actions={<Link to="/expenses">Ledger</Link>}
    >
      {query.isError ? (
        <ErrorDisplay
          error={query.error}
          title="recorded spend"
          onRetry={() => void query.refetch()}
          className="mt-2"
        />
      ) : monthly === undefined ? (
        <HomeRowsLoading label="Loading recorded spend" />
      ) : query.data?.length === 0 ? (
        <EmptyState size="inline" className="mt-2">
          No recorded expenses in the last six months.
        </EmptyState>
      ) : (
        <>
          <p id={summaryId} className="sr-only">
            {describeRecordedSpendChange(current, monthly.at(-2))} Recorded
            expenses only.
          </p>
          <HomeList label="Recorded spend by month">
            {[...monthly].reverse().map((row) => {
              const isCurrent = row.month === current?.month;
              return (
                <HomeRow
                  key={row.month}
                  leading={formatCalendarDay(`${row.month}-01`, "monthShort")}
                  trailing={
                    <CurrencyValue
                      value={row.net}
                      // A credit month keeps its sign tone.
                      className={cn(
                        "font-mono",
                        isCurrent && "font-semibold text-foreground-strong",
                      )}
                    />
                  }
                >
                  <span className="truncate text-xs text-muted-foreground">
                    {isCurrent
                      ? "This month"
                      : row.count > 0
                        ? `${formatCount(row.count)} expenses`
                        : null}
                  </span>
                </HomeRow>
              );
            })}
          </HomeList>
        </>
      )}
    </Section>
  );
}
