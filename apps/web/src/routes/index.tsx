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
import { Grid, Section, Stack } from "~/components/layout";
import { DashboardCard } from "~/components/layout/dashboard-card";
import { LazyMount } from "~/components/lazy-mount";
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
      fullWidth
    >
      {/* Red alert bar — only rendered when problems > 0. */}
      <ProblemsBanner />

      {/* The household's two live operating signals lead the page. Mobile
          puts pantry first because it is the physical, daily-use check. */}
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

      <Section title="Current position">
        <EntityCount />
      </Section>

      {/* Activity and the practical next actions stay immediately after the
          signals. The heavier relationship views remain lazy below. */}
      <Grid cols="pair" gap="md">
        <Stack className="lg:order-2">
          <QuickActionsCard />
          <MealsCard />
          <HouseCard />
        </Stack>
        <div className="lg:order-1">
          <RecentActivityFeed limit={6} />
        </div>
      </Grid>

      {/* Insights — the visualization panels folded in from the retired
          /insights page. All sit below the fold, so each is LazyMount-gated:
          its queries fire only when scrolled near (home is the most-visited
          route, and the co-occurrence/usage queries are the heaviest reads —
          don't pay them on every landing). */}
      <Section title="Insights">
        <Grid cols="pair" gap="md">
          <DashboardCard
            icon={PieChart}
            title="Products by Category"
            description="Distribution across categories — click a slice to view products."
          >
            <LazyMount>
              <ProductCategoryDonut />
            </LazyMount>
          </DashboardCard>

          <DashboardCard
            icon={MapPin}
            title="Inventory by Location"
            description="Where inventory value sits across your locations."
          >
            <LazyMount>
              <LocationSunburst />
            </LazyMount>
          </DashboardCard>

          <DashboardCard
            icon={Share2}
            title="Ingredient Relationships"
            description="Ingredients that co-occur across recipes; larger nodes are used more."
          >
            <LazyMount>
              <IngredientNetwork />
            </LazyMount>
          </DashboardCard>

          <DashboardCard
            icon={ListChecks}
            title="Ingredient Usage"
            description="How many recipes use each ingredient; scope by cookbook."
          >
            <LazyMount>
              <IngredientUsageSection />
            </LazyMount>
          </DashboardCard>
        </Grid>
      </Section>
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
