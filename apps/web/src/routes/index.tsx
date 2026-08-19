import type { CookbookShortcode } from "@cubby/schemas/identifiers";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { ListChecks, MapPin, PieChart, Share2 } from "lucide-react";
import { useEffect, useState } from "react";
import { HouseCard } from "~/app/_components/home/HouseCard";
import { MealsCard } from "~/app/_components/home/MealsCard";
import { PantryValueCard } from "~/app/_components/home/PantryValueCard";
import { QuickActionsCard } from "~/app/_components/home/QuickActionsCard";
import { RecentActivityFeed } from "~/app/_components/home/RecentActivityFeed";
import { RecordedSpendCard } from "~/app/_components/home/RecordedSpendCard";
import EntityCount from "~/app/_components/homepage/entitycount";
import { ProblemsBanner } from "~/app/_components/homepage/problems-banner";
import { IngredientUsagePanel } from "~/app/_components/ingredient/ingredient-usage-panel";
import { CookbookSelect } from "~/app/_components/recipe/cookbook-select";
import IngredientNetwork from "~/app/_components/visualizations/ingredient-network";
import LocationSunburst from "~/app/_components/visualizations/location-sunburst";
import ProductCategoryDonut from "~/app/_components/visualizations/product-category-donut";
import { CollapsibleSection, Grid, Section, Stack } from "~/components/layout";
import { DashboardCard } from "~/components/layout/dashboard-card";
import { Page } from "~/components/page/Page";
import { authClient } from "~/lib/auth-client";

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
  // Warm the count-card query during route load so it's already in flight when
  // EntityCount mounts (most useful on client-side navigation). One call covers
  // every homepage total (dashboard.counts). Non-blocking `void prefetch` (not
  // awaited ensure): the SSR tRPC client targets localhost, which is unreachable
  // on CF Workers — so awaiting here would break prod. EntityCount's own gate +
  // skeleton covers cold loads.
  loader: ({ context }) => {
    const { queryClient, trpc } = context;
    void queryClient.prefetchQuery(trpc.dashboard.counts.queryOptions());
    // Problems count is fetched client-side by the badge/card via the five
    // cost-grouped queries (no monolithic getAllProblems). Not prefetched here:
    // SSR self-fetch is unauthenticated and we don't want the heavy detectors
    // running in the SSR invocation.
    // Warm the location tree — the pantry-value card reads each location's
    // persisted valuation rollup from it (no inventory fetch).
    void queryClient.prefetchQuery(trpc.location.makeTree.queryOptions());
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
      eyebrow="Keep everything in its place"
      title={greeting}
      actions={
        now ? (
          <p className="hidden font-mono text-2xs text-muted-foreground uppercase sm:block">
            {now.toLocaleDateString("en-US", {
              weekday: "short",
              day: "2-digit",
              month: "short",
              year: "numeric",
            })}
          </p>
        ) : null
      }
      layout="full"
    >
      {/* Status bar — absent only when there is nothing outstanding at all.
          It carries the destructive tone for real defects and a quiet one for
          a coverage-only backlog, which is why it can render either way. */}
      <ProblemsBanner />

      {/* What to act on leads the page. The ordering rule for this route is
          "does this number change what I do in the next ten minutes" — open
          work and this week's meals do; a valuation total does not, so the
          signals region now sits below rather than above. On a phone this
          also means the first viewport is work, not net worth. */}
      <Section
        title="Needs attention"
        description="Open work and what is planned to cook."
      >
        <Grid cols="pair" gap="md">
          <HouseCard />
          <MealsCard />
        </Grid>
      </Section>

      <QuickActionsCard />

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
            <RecordedSpendCard />
          </div>
        </Grid>
      </Section>

      {/* Activity is useful context after the immediate operating picture, but
          it does not compete with today's actions for the first decision. */}
      <Section title="Recent activity">
        <RecentActivityFeed limit={6} />
      </Section>

      <CollapsibleSection
        title="Browse records"
        summary="Everything the household has on record"
      >
        <EntityCount />
      </CollapsibleSection>

      {/* Insights — the visualization panels folded in from the retired
          /insights page. Exploration, not operation: they are the heaviest
          reads on the most-visited route and the least likely to change what
          anyone does next, so the whole region is collapsed by default.
          The disclosure IS the gate — CollapsibleSection mounts its body only
          while open, so a closed region runs no queries at all, and the panels
          need no per-panel scroll-gating of their own. */}
      <CollapsibleSection title="Insights" summary="Four exploratory views">
        <Grid cols="pair" gap="md">
          <DashboardCard
            icon={PieChart}
            title="Products by category"
            description="Distribution across categories — click a slice to view products."
          >
            <ProductCategoryDonut />
          </DashboardCard>

          <DashboardCard
            icon={MapPin}
            title="Inventory by location"
            description="Where inventory value sits across your locations."
          >
            <LocationSunburst />
          </DashboardCard>

          <DashboardCard
            icon={Share2}
            title="Ingredient relationships"
            description="Ingredients that co-occur across recipes; larger nodes are used more."
          >
            <IngredientNetwork />
          </DashboardCard>

          <DashboardCard
            icon={ListChecks}
            title="Ingredient usage"
            description="How many recipes use each ingredient; scope by cookbook."
          >
            <IngredientUsageSection />
          </DashboardCard>
        </Grid>
      </CollapsibleSection>
    </Page>
  );
}

function IngredientUsageSection() {
  const [cookbookId, setCookbookId] = useState<CookbookShortcode | undefined>();

  return (
    <Stack>
      <CookbookSelect value={cookbookId} onChange={setCookbookId} />
      {/* 12 bars ≈ the network panel's 400px, so the insight row stays level. */}
      <IngredientUsagePanel cookbookId={cookbookId} limit={12} />
    </Stack>
  );
}
