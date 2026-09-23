import { createFileRoute, redirect } from "@tanstack/react-router";
import { lazy, Suspense, useEffect, useState } from "react";

import { getHomeAsOfWindow } from "~/app/_components/home/home-as-of-window";
import { TodayAttention } from "~/app/_components/home/HouseCard";
import { TodayMeals } from "~/app/_components/home/MealsCard";
import { PantryValueCard } from "~/app/_components/home/PantryValueCard";
import { DailyPasses } from "~/app/_components/home/QuickActionsCard";
import { RecentActivityFeed } from "~/app/_components/home/RecentActivityFeed";
import { RecordedSpendCard } from "~/app/_components/home/RecordedSpendCard";
import { ProblemsBanner } from "~/app/_components/homepage/problems-banner";
import { expense } from "~/app/expenses/expense.functions";
import { location } from "~/app/locations/location.functions";
import { TodayNutrition } from "~/app/meals/daily-nutrition";
import { meal } from "~/app/meals/meal.functions";
import { task } from "~/app/tasks/task.functions";
import { CollapsibleSection, Grid, Section } from "~/components/layout";
import { Page } from "~/components/page/Page";
import { authClient } from "~/lib/auth-client";
import { problems } from "~/lib/problems.functions";

const HomeInsights = lazy(async () => {
  const module = await import("~/app/_components/home/HomeInsights");
  return { default: module.HomeInsights };
});

const EntityCount = lazy(
  () => import("~/app/_components/homepage/entitycount"),
);

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
      context.queryClient.ensureQueryData(task.todayBriefing.queryOptions()),
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

function timeOfDay(date: Date): string {
  const hour = date.getHours();
  if (hour < 12) return "morning";
  if (hour < 18) return "afternoon";
  return "evening";
}

function Home() {
  const { asOf } = Route.useLoaderData();
  const session = authClient.useSession();
  // Clock-dependent text is set after mount so SSR (UTC) and the client's
  // local timezone can't disagree during hydration.
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => setNow(new Date()), []);

  const firstName = session.data?.user?.name?.split(" ")[0];
  const greeting =
    now && firstName
      ? `Good ${timeOfDay(now)}, ${firstName}.`
      : "Welcome home.";

  return (
    <Page
      variant="list"
      title={greeting}
      mobileTitleVisible
      actions={
        now ? (
          <p className="font-mono text-2xs text-muted-foreground uppercase">
            {now.toLocaleDateString("en-US", {
              weekday: "short",
              day: "2-digit",
              month: "short",
              year: "numeric",
            })}
          </p>
        ) : null
      }
      layout="contained"
    >
      {/* Status bar — absent only when there is nothing outstanding at all.
          It carries the destructive tone for real defects and a quiet one for
          a coverage-only backlog, which is why it can render either way. */}
      <ProblemsBanner />

      {/* The briefing reads tasks, meals, recurring actions, then nutrition on
          a phone. Desktop keeps tasks and meals side by side. */}
      <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(18rem,1fr)]">
        <div className="contents lg:grid lg:content-start lg:gap-6">
          <div className="order-1 lg:order-none">
            <TodayAttention />
          </div>
          <div className="order-3 lg:order-none">
            <DailyPasses />
          </div>
        </div>
        <div className="contents lg:grid lg:content-start lg:gap-6">
          <div className="order-2 lg:order-none">
            <TodayMeals asOf={asOf} />
          </div>
          <div className="order-4 lg:order-none">
            <TodayNutrition initialDate={asOf.meals.from} />
          </div>
        </div>
      </div>

      {/* The household's two operating signals — state of what is on hand and
          what has been spent. Mobile puts pantry first because it is the
          physical, daily-use check. */}
      <Section
        title="Household signals"
        description="The state of what is on hand and what has been spent."
      >
        <Grid cols="pair" gap="md">
          <div className="lg:order-2">
            <PantryValueCard />
          </div>
          <div className="lg:order-1">
            <RecordedSpendCard asOf={asOf} />
          </div>
        </Grid>
      </Section>

      {/* Activity is useful context after the immediate operating picture, but
          it does not compete with today's actions for the first decision. */}
      <Section
        title="What changed"
        description="The latest recorded changes across the household."
      >
        <RecentActivityFeed limit={6} />
      </Section>

      <CollapsibleSection
        title="Browse records"
        summary="Everything the household has on record"
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
      </CollapsibleSection>

      {/* Insights — the visualization panels folded in from the retired
          /insights page. Exploration, not operation: they are the heaviest
          reads on the most-visited route and the least likely to change what
          anyone does next, so the whole region is collapsed by default.
          The disclosure IS the gate — CollapsibleSection mounts its body only
          while open, so a closed region runs no queries at all, and the panels
          need no per-panel scroll-gating of their own. */}
      <CollapsibleSection title="Insights" summary="Four exploratory views">
        <Suspense
          fallback={
            <output className="block min-h-24 text-sm text-muted-foreground">
              Loading insights…
            </output>
          }
        >
          <HomeInsights />
        </Suspense>
      </CollapsibleSection>
    </Page>
  );
}
