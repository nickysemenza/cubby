import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { lazy, Suspense } from "react";

import { createActionFor } from "~/entity/actions/action-items";
import { Page } from "~/entity/page/page";
import { getHomeAsOfWindow } from "~/features/home/home-as-of-window";
import { HomeKeyNumbers } from "~/features/home/home-key-numbers";
import { HomeMoney } from "~/features/home/home-money";
import { HomePantry } from "~/features/home/home-pantry";
import { TodayAttention } from "~/features/home/house-card";
import { TodayMeals } from "~/features/home/meals-card";
import { NeedsYou } from "~/features/home/needs-you";
import { PinnedViews } from "~/features/home/pinned-views";
import { RecentActivityFeed } from "~/features/home/recent-activity-feed";
import { TodayNutrition } from "~/features/meal/daily-nutrition";
import { installFeatures } from "~/features/registry";
import { cursorQueryOptions } from "~/integrations/tanstack-query/cursor-query-options";
import {
  expense,
  location,
  meal,
  entityReport,
  problems,
} from "~/integrations/tanstack-query/generated/catalog.gen";
import { formatCalendarDay } from "~/lib/date-format";
import { Section } from "~/ui/layout";
import { PageHeader } from "~/ui/layout/page-header";
import { Button } from "~/ui/primitives/button";

const HomeInsights = lazy(async () => {
  const module = await import("~/features/home/home-insights");
  return { default: module.HomeInsights };
});

const EntityCount = lazy(() => import("~/features/home/entitycount"));

const LOG_MEAL = createActionFor("meal");
const NEW_TASK = createActionFor("task");

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
  loader: async ({ context }) => {
    const asOf = getHomeAsOfWindow();
    await Promise.allSettled([
      context.queryClient.ensureQueryData(
        meal.getNutrition.queryOptions({ date: asOf.meals.from }),
      ),
      context.queryClient.ensureQueryData(problems.getCounts.queryOptions()),
      context.queryClient.ensureInfiniteQueryData(
        cursorQueryOptions(entityReport.get, {
          slot: "task.briefing",
          scope: { kind: "list", entity: "task", filters: {} },
        }),
      ),
      context.queryClient.ensureQueryData(
        meal.upcomingSummary.queryOptions(asOf.meals),
      ),
      context.queryClient.ensureQueryData(
        location.valuationSummary.queryOptions(),
      ),
      context.queryClient.ensureQueryData(
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
  // The loader's household-local day, so SSR and hydration print one title.
  const today = asOf.meals.from;

  return (
    <Page variant="bare" layout="contained">
      <PageHeader
        layout="stacked"
        title={formatCalendarDay(today, "weekdayLongMonthDay")}
        actions={
          <>
            {LOG_MEAL && (
              <Button
                variant="outline"
                nativeButton={false}
                render={<Link to={LOG_MEAL.to} search={LOG_MEAL.search} />}
              >
                Log meal
              </Button>
            )}
            {NEW_TASK && (
              <Button
                nativeButton={false}
                render={<Link to={NEW_TASK.to} search={NEW_TASK.search} />}
              >
                New task
              </Button>
            )}
          </>
        }
      />

      {/* Current work leads; the rail holds household context and, below
          the wide breakpoint, follows the main column. */}
      <div className="mt-3 grid grid-cols-1 gap-x-5 gap-y-4 pb-8 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-4">
          <HomeKeyNumbers asOf={asOf} />
          <div className="grid grid-cols-1 items-start gap-x-5 gap-y-4 md:grid-cols-2">
            <TodayAttention />
            <NeedsYou />
          </div>
          <RecentActivityFeed limit={6} />
          <Section
            headingAs="h2"
            title="Browse records"
            caption="Everything the household has on record"
            disclosure={{}}
          >
            <Suspense
              fallback={
                <output className="block min-h-24 text-sm text-muted-foreground">
                  Loading record counts…
                </output>
              }
            >
              <EntityCount />
            </Suspense>
          </Section>
          {/* Insights — exploration, not operation: the heaviest reads on the
              most-visited route and the least likely to change what anyone
              does next, so the region is collapsed by default. Section mounts
              its body only while open, so a closed region runs no queries. */}
          <Section
            headingAs="h2"
            title="Insights"
            caption="Four exploratory views"
            disclosure={{}}
          >
            <Suspense
              fallback={
                <output className="block min-h-24 text-sm text-muted-foreground">
                  Loading insights…
                </output>
              }
            >
              <HomeInsights />
            </Suspense>
          </Section>
        </div>
        <aside
          aria-label="Household context"
          className="flex min-w-0 flex-col gap-4"
        >
          <TodayMeals asOf={asOf} />
          <HomeMoney asOf={asOf} />
          <TodayNutrition initialDate={asOf.meals.from} />
          <HomePantry />
          <PinnedViews />
        </aside>
      </div>
    </Page>
  );
}
