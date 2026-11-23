import { Link } from "@tanstack/react-router";
import { lazy, Suspense } from "react";

import { createActionFor } from "~/entity/actions/action-items";
import { CreateDialogAction } from "~/entity/editing/create-dialog-action";
import { captureRequest } from "~/entity/editing/editor-requests";
import { Page } from "~/entity/page/page";
import { TodayNutrition } from "~/features/meal/daily-nutrition";
import { formatCalendarDay } from "~/lib/date-format";
import { QuerySection } from "~/ui/feedback/query-section";
import { VisibleContent } from "~/ui/hooks/visible-content";
import { Section } from "~/ui/layout";
import { PageHeader } from "~/ui/layout/page-header";
import { Button } from "~/ui/primitives/button";

import type { HomeAsOfWindow } from "./home-as-of-window";
import { HomeKeyNumbers } from "./home-key-numbers";
import { HomeCard, HomeRowsLoading } from "./home-list";
import { HomeMoney } from "./home-money";
import { HomePantry } from "./home-pantry";
import { TodayAttention } from "./house-card";
import { TodayMeals } from "./meals-card";
import { NeedsYou } from "./needs-you";
import { PinnedViews } from "./pinned-views";
import { RecentActivityFeed } from "./recent-activity-feed";

const HomeInsights = lazy(async () => {
  const module = await import("./home-insights");
  return { default: module.HomeInsights };
});

const EntityCount = lazy(() => import("./entitycount"));

const LOG_MEAL = createActionFor("meal");
const NEW_TASK = createActionFor("task");

/**
 * Today: white cards on the page canvas. The household figures lead as one
 * summary card; current work fills the main column and household context the
 * second column from 1000px of pane, and below that the second column follows
 * the first.
 */
export function TodayPage({ asOf }: { asOf: HomeAsOfWindow }) {
  return (
    <Page variant="bare" layout="contained" canvas>
      <PageHeader
        layout="stacked"
        // The loader's household-local day, so SSR and hydration print one title.
        title={formatCalendarDay(asOf.meals.from, "weekdayLongMonthDay")}
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
              <CreateDialogAction request={captureRequest("task")}>
                New task
              </CreateDialogAction>
            )}
          </>
        }
      />
      <div className="@container/today mt-3 pb-8">
        <div className="grid grid-cols-1 gap-(--record-card-gap) @min-[1000px]/today:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
          <HomeCard className="overflow-hidden p-0! @min-[1000px]/today:col-span-2">
            <QuerySection
              title="household key numbers"
              fallback={
                <HomeRowsLoading
                  label="Loading household key numbers"
                  rows={1}
                />
              }
            >
              <HomeKeyNumbers asOf={asOf} />
            </QuerySection>
          </HomeCard>
          <div className="flex min-w-0 flex-col gap-(--record-card-gap)">
            <div className="@container/pair">
              <div className="grid grid-cols-1 items-start gap-(--record-card-gap) @min-[36rem]/pair:grid-cols-2">
                <HomeCard>
                  <TodayAttention />
                </HomeCard>
                <HomeCard>
                  <NeedsYou />
                </HomeCard>
              </div>
            </div>
            <HomeCard>
              <RecentActivityFeed limit={6} />
            </HomeCard>
            <HomeCard>
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
            </HomeCard>
            {/* Insights — exploration, not operation: the heaviest reads on
                the most-visited route and the least likely to change what
                anyone does next, so the region is collapsed by default.
                Section mounts its body only while open, so a closed region
                runs no queries. */}
            <HomeCard>
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
            </HomeCard>
          </div>
          <aside
            aria-label="Household context"
            className="flex min-w-0 flex-col gap-(--record-card-gap)"
          >
            <HomeCard>
              <TodayMeals asOf={asOf} />
            </HomeCard>
            <HomeCard>
              <HomeMoney asOf={asOf} />
            </HomeCard>
            <HomeCard>
              <VisibleContent
                fallback={
                  <HomeRowsLoading label="Loading nutrition" rows={2} />
                }
              >
                <TodayNutrition initialDate={asOf.meals.from} />
              </VisibleContent>
            </HomeCard>
            <HomeCard>
              <HomePantry />
            </HomeCard>
            <PinnedViews />
          </aside>
        </div>
      </div>
    </Page>
  );
}
