import type { ExpenseMonthlyAggregate } from "@cubby/schemas/project";
import { ChartBarIcon } from "@phosphor-icons/react/dist/csr/ChartBar";
import { useQuery } from "@tanstack/react-query";
import { format, parseISO } from "date-fns";
import { useId, useMemo } from "react";

import { expense } from "~/app/expenses/expense.functions";
import { Row } from "~/components/layout";
import {
  CardActionLink,
  DashboardCard,
} from "~/components/layout/dashboard-card";
import { Button } from "~/components/ui/button";
import { Skeleton } from "~/components/ui/skeleton";
import { formatCurrency } from "~/lib/utils";

import { getHomeAsOfWindow, type HomeAsOfWindow } from "./home-as-of-window";

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
 * client-side total and never Purchase.statedTotal.
 */
export function RecordedSpendCard({ asOf }: { asOf: HomeAsOfWindow }) {
  const query = useQuery({
    ...expense.monthlySummary.queryOptions(asOf.spend.filters),
  });

  const monthly = useMemo(
    () => fillRecordedSpendMonths(query.data ?? [], asOf.spend.months),
    [asOf.spend.months, query.data],
  );
  const current = monthly.at(-1);
  const previous = monthly.at(-2);

  return (
    <DashboardCard
      icon={ChartBarIcon}
      title="Recorded spend"
      description="Last six calendar months · actual expenses only"
      action={<CardActionLink to="/expenses">Ledger</CardActionLink>}
    >
      {query.isLoading ? (
        <>
          <Skeleton className="h-7 w-24" />
          <Skeleton className="mt-4 h-40 w-full" />
        </>
      ) : query.isError ? (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Spend is unavailable right now.
          </p>
          <Button
            type="button"
            variant="outline"
            className="h-11 sm:h-7"
            onClick={() => query.refetch()}
          >
            Retry
          </Button>
        </div>
      ) : query.data?.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No recorded expenses in this period.
        </p>
      ) : (
        <>
          <Row align="baseline" gap="xs">
            <span className="font-mono text-xl font-semibold tabular-nums">
              {formatCurrency(current?.net ?? 0)}
            </span>
            <span className="text-xs text-muted-foreground">this month</span>
          </Row>
          <p className="mt-1 text-xs text-muted-foreground">
            {describeRecordedSpendChange(current, previous)} Recorded expenses
            only; open Ledger to review the entries behind this total.
          </p>
          <RecordedSpendBars monthly={monthly} />
        </>
      )}
    </DashboardCard>
  );
}

function RecordedSpendBars({
  monthly,
}: {
  monthly: ExpenseMonthlyAggregate[];
}) {
  const summaryId = useId();
  const maxMagnitude = Math.max(...monthly.map((row) => Math.abs(row.net)), 1);
  const currentMonth = monthly.at(-1);
  const previousMonth = monthly.at(-2);

  return (
    <figure className="mt-2" aria-labelledby={summaryId}>
      <figcaption id={summaryId} className="sr-only">
        How is recorded spend changing month to month? Current month is
        {formatCurrency(currentMonth?.net ?? 0)}.{" "}
        {describeRecordedSpendChange(currentMonth, previousMonth)} Recorded
        expenses only.
      </figcaption>
      <div
        aria-hidden="true"
        className="flex h-32 gap-1 border-b border-[var(--border)] px-1"
      >
        {monthly.map((row) => {
          const magnitude = (Math.abs(row.net) / maxMagnitude) * 100;
          const height = row.net === 0 ? 0 : Math.max(6, magnitude);
          return (
            <div
              key={row.month}
              className="grid min-w-0 flex-1 grid-rows-[1fr_1px_1fr]"
            >
              <div className="flex items-end justify-center">
                {row.net >= 0 && (
                  <div
                    className={
                      row.month === currentMonth?.month
                        ? "w-full bg-chart-1"
                        : "w-full bg-chart-2"
                    }
                    style={{ height: `${height}%` }}
                  />
                )}
              </div>
              <div className="bg-border" />
              <div className="flex items-start justify-center">
                {row.net < 0 && (
                  <div
                    className="w-full bg-destructive/70"
                    style={{ height: `${height}%` }}
                  />
                )}
              </div>
            </div>
          );
        })}
      </div>
      <div className="mt-2 flex gap-1 px-1" aria-hidden="true">
        {monthly.map((row) => (
          <span
            key={row.month}
            className="min-w-0 flex-1 truncate text-center font-mono text-2xs text-muted-foreground uppercase"
          >
            {format(parseISO(`${row.month}-01`), "MMM")}
          </span>
        ))}
      </div>
      <ul className="sr-only">
        {monthly.map((row) => (
          <li key={row.month}>
            {format(parseISO(`${row.month}-01`), "MMMM yyyy")}:{" "}
            {formatCurrency(row.net)}
          </li>
        ))}
      </ul>
    </figure>
  );
}
