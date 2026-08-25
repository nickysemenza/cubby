import type { ExpenseMonthlyAggregate } from "@cubby/schemas/project";
import { useQuery } from "@tanstack/react-query";
import { addMonths, endOfMonth, format, startOfMonth } from "date-fns";
import { ChartNoAxesColumnIncreasing } from "lucide-react";
import { useMemo } from "react";
import { MonthlySpend } from "~/app/expenses/charts/monthly-spend";
import { expenseMonthlySummaryQueryOptions } from "~/app/expenses/expense.functions";
import { Row } from "~/components/layout";
import {
  CardActionLink,
  DashboardCard,
} from "~/components/layout/dashboard-card";
import { Skeleton } from "~/components/ui/skeleton";
import { useHydrated } from "~/hooks/useHydrated";
import { authClient } from "~/lib/auth-client";
import { formatCurrency } from "~/lib/utils";

const MONTH_COUNT = 6;

function recentMonths(now: Date): string[] {
  return Array.from({ length: MONTH_COUNT }, (_, index) =>
    format(addMonths(now, index - (MONTH_COUNT - 1)), "yyyy-MM"),
  );
}

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

export function getRecordedSpendWindow(now: Date) {
  const months = recentMonths(now);
  const dateFrom = format(
    startOfMonth(addMonths(now, -(MONTH_COUNT - 1))),
    "yyyy-MM-dd",
  );
  const dateTo = format(endOfMonth(now), "yyyy-MM-dd");
  return {
    months,
    filters: { dateFrom, dateTo, future: false as const },
  };
}

/**
 * Six complete/current calendar months of recorded household spend. This is a
 * focused home read over the ledger's existing SQL aggregate, never a second
 * client-side total and never Purchase.statedTotal.
 */
export function RecordedSpendCard() {
  const session = authClient.useSession();
  const hydrated = useHydrated();
  const isAuthenticated = hydrated && !!session.data?.user;
  const spendWindow = useMemo(() => {
    const now = hydrated ? new Date() : new Date(0);
    return getRecordedSpendWindow(now);
  }, [hydrated]);
  const { months, filters } = spendWindow;
  const query = useQuery({
    ...expenseMonthlySummaryQueryOptions(filters),
    enabled: isAuthenticated,
    staleTime: 60 * 1000,
  });

  const monthly = useMemo(
    () => fillRecordedSpendMonths(query.data ?? [], months),
    [months, query.data],
  );
  const currentMonth = monthly.at(-1)?.net ?? 0;

  return (
    <DashboardCard
      icon={ChartNoAxesColumnIncreasing}
      title="Recorded spend"
      description="Last six calendar months · actual expenses only"
      action={<CardActionLink to="/expenses">Ledger</CardActionLink>}
    >
      {!isAuthenticated || query.isLoading ? (
        <>
          <Skeleton className="h-7 w-24" />
          <Skeleton className="mt-4 h-40 w-full" />
        </>
      ) : query.isError ? (
        <p className="text-muted-foreground text-sm">
          Spend is unavailable right now.
        </p>
      ) : query.data?.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          No recorded expenses in this period.
        </p>
      ) : (
        <>
          <Row align="baseline" gap="xs">
            <span className="font-mono font-semibold text-xl tabular-nums">
              {formatCurrency(currentMonth)}
            </span>
            <span className="text-muted-foreground text-xs">this month</span>
          </Row>
          <div className="mt-2">
            <MonthlySpend monthly={monthly} compact />
          </div>
        </>
      )}
    </DashboardCard>
  );
}
