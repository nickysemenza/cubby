import { createFileRoute, redirect } from "@tanstack/react-router";

import { getHomeAsOfWindow } from "~/features/home/home-as-of-window";
import { TodayPage } from "~/features/home/today-page";
import { installFeatures } from "~/features/registry";
import { cursorQueryOptions } from "~/integrations/tanstack-query/cursor-query-options";
import { auditLog } from "~/integrations/tanstack-query/generated/domains/auditLog.gen";
import { entityReport } from "~/integrations/tanstack-query/generated/domains/entityReport.gen";
import { expense } from "~/integrations/tanstack-query/generated/domains/expense.gen";
import { location } from "~/integrations/tanstack-query/generated/domains/location.gen";
import { machinery } from "~/integrations/tanstack-query/generated/domains/machinery.gen";
import { meal } from "~/integrations/tanstack-query/generated/domains/meal.gen";

export const Route = createFileRoute("/")({
  // The home dashboard is authenticated-only (the counts/feeds are all
  // per-user). Guard it like `_authenticated` so a logged-out load redirects
  // to sign-in instead of rendering a dashboard of zeros. Reuses the root's
  // server-side session read via context.
  beforeLoad: ({ context }) => {
    if (!context.isAuthed) {
      throw redirect({
        to: "/auth/$authView",
        params: { authView: "sign-in" },
      });
    }
  },
  loader: ({ context }) => {
    const asOf = getHomeAsOfWindow();
    void Promise.allSettled([
      context.queryClient.prefetchQuery(machinery.needsYou.queryOptions({})),
      context.queryClient.prefetchInfiniteQuery(
        cursorQueryOptions(auditLog.list, { limit: 6 }),
      ),
      context.queryClient.prefetchInfiniteQuery(
        cursorQueryOptions(entityReport.get, {
          slot: "task.briefing",
          scope: { kind: "list", entity: "task", filters: {} },
        }),
      ),
      context.queryClient.prefetchQuery(
        meal.upcomingSummary.queryOptions(asOf.meals),
      ),
      context.queryClient.prefetchQuery(
        location.valuationSummary.queryOptions(),
      ),
      context.queryClient.prefetchQuery(
        expense.monthlySummary.queryOptions(asOf.spend.filters),
      ),
    ]);
    return { asOf };
  },
  component: Home,
});

function Home() {
  // Home sits outside `_authenticated`, which otherwise installs the feature
  // registry its pickers read; idempotent.
  installFeatures();
  const { asOf } = Route.useLoaderData();
  return <TodayPage asOf={asOf} />;
}
