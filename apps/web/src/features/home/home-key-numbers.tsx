import {
  useSuspenseQuery,
  useSuspenseInfiniteQuery,
} from "@tanstack/react-query";

import { cursorQueryOptions } from "~/integrations/tanstack-query/cursor-query-options";
import { entityReport } from "~/integrations/tanstack-query/generated/catalog/entityReport.gen";
import { expense } from "~/integrations/tanstack-query/generated/catalog/expense.gen";
import { location } from "~/integrations/tanstack-query/generated/catalog/location.gen";
import { workQueue } from "~/integrations/tanstack-query/generated/catalog/workQueue.gen";
import { formatCalendarDay } from "~/lib/date-format";
import { formatCount, formatCurrency } from "~/lib/number-format";
import { KeyNumbers, type KeyNumber } from "~/ui/common/key-numbers";
import { Skeleton } from "~/ui/primitives/skeleton";

import type { HomeAsOfWindow } from "./home-as-of-window";
import { useRecordedSpend } from "./home-money";
import { usePantryValue } from "./home-pantry";
import { taskBriefingReportInput, useTaskBriefing } from "./house-card";
import { NEEDS_YOU_INPUT, useNeedsYou } from "./needs-you";

/** A figure still loading shows a placeholder; a failed read shows a dash
 * (its section below carries the raw error and Retry). */
function figure<T>(
  read: { data: T | undefined; isError: boolean },
  format: (data: T) => string,
) {
  if (read.data !== undefined) return format(read.data);
  return read.isError ? "—" : <Skeleton className="mt-1 h-6 w-16" />;
}

/**
 * Home's four figures, each an existing read the page already shows below:
 * the task briefing's due counts, the Review work routed to me, this month's
 * recorded spend, and the pantry's valuation total. No pace, score or
 * forecast.
 */
export function HomeKeyNumbers({ asOf }: { asOf: HomeAsOfWindow }) {
  useSuspenseInfiniteQuery(
    cursorQueryOptions(entityReport.get, taskBriefingReportInput),
  );
  useSuspenseQuery(workQueue.queue.queryOptions(NEEDS_YOU_INPUT));
  useSuspenseQuery(expense.monthlySummary.queryOptions(asOf.spend.filters));
  useSuspenseQuery(location.valuationSummary.queryOptions());
  const briefing = useTaskBriefing();
  const needsYou = useNeedsYou();
  const spend = useRecordedSpend(asOf);
  const pantry = usePantryValue();
  const today = asOf.meals.from;
  const items: KeyNumber[] = [
    {
      id: "tasks-due",
      label: "Tasks due",
      value: figure(
        { data: briefing.rows, isError: briefing.query.isError },
        () =>
          formatCount(
            briefing.count("Overdue") + briefing.count("Due this week"),
          ),
      ),
      context:
        briefing.count("Overdue") > 0
          ? `${formatCount(briefing.count("Overdue"))} overdue`
          : "This week",
    },
    {
      id: "needs-you",
      label: "Needs you",
      value: figure(needsYou, (data) => formatCount(data.meta.totalCount)),
      context: "To review",
    },
    {
      id: "spent",
      label: "Spent this month",
      value: figure(
        { data: spend.monthly, isError: spend.query.isError },
        (monthly) => formatCurrency(monthly.at(-1)?.net ?? 0),
      ),
      context: `${formatCalendarDay(`${today.slice(0, 7)}-01`, "monthDay")}–${Number(today.slice(8, 10))}`,
    },
    {
      id: "pantry",
      label: "Pantry on hand",
      value: figure(pantry, (data) => formatCurrency(data.total)),
      context: "Recorded value",
    },
  ];
  return (
    <KeyNumbers layout="strip" label="Household key numbers" items={items} />
  );
}
