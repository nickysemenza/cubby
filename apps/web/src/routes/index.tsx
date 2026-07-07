import { unsafeCookbookId } from "@cubby/schemas/identifiers";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { PantryValueCard } from "~/app/_components/home/PantryValueCard";
import { QuickActionsCard } from "~/app/_components/home/QuickActionsCard";
import { RecentActivityFeed } from "~/app/_components/home/RecentActivityFeed";
import EntityCount from "~/app/_components/homepage/entitycount";
import { IngredientUsagePanel } from "~/app/_components/ingredient/ingredient-usage-panel";
import { CategoryAudit } from "~/app/_components/insights/category-audit";
import IngredientNetwork from "~/app/_components/visualizations/ingredient-network";
import LocationSunburst from "~/app/_components/visualizations/location-sunburst";
import ProductCategoryDonut from "~/app/_components/visualizations/product-category-donut";
import { Row, Section, Stack } from "~/components/layout";
import { Page } from "~/components/page/Page";
import { authClient } from "~/lib/auth-client";
import { useTRPC } from "~/trpc/react";

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
  // all seven totals (dashboard.counts). Non-blocking `void prefetch` (not
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
      {/* Entity Stats + problems alert */}
      <EntityCount />

      {/* Two-column layout: activity ledger on the left, actions + pantry
          value chart on the right. On mobile, create-actions surface first. */}
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="flex flex-col gap-4 lg:order-2">
          <QuickActionsCard />
          <PantryValueCard />
        </div>
        <div className="lg:order-1">
          <RecentActivityFeed limit={6} />
        </div>
      </div>

      {/* Insights — the visualization sections folded in from the retired
          /insights page. Each renders lazily via its own query. */}
      <Section
        title="Products by Category"
        description="Distribution of products across categories. Click a slice to view products in that category."
      >
        <ProductCategoryDonut />
      </Section>

      <Section title="Inventory by Location">
        <LocationSunburst />
      </Section>

      <Section
        title="Ingredient Relationships"
        description="Ingredients that appear together in multiple recipes are connected. Larger nodes indicate ingredients used in more recipes."
      >
        <IngredientNetwork />
      </Section>

      <Section
        title="Ingredient Usage"
        description="How many recipes use each ingredient. Scope to a cookbook, and merge near-duplicate names inline."
      >
        <IngredientUsageSection />
      </Section>

      <Section
        title="Category Audit"
        description="Use AI to analyze your product catalog and suggest new categories that could better organize your inventory."
      >
        <CategoryAudit />
      </Section>
    </Page>
  );
}

function IngredientUsageSection() {
  const api = useTRPC();
  const { data: cookbooks } = useQuery(api.recipe.listCookbooks.queryOptions());
  const [cookbookId, setCookbookId] = useState<string>("");

  return (
    <Stack>
      <Row as="label" align="center" gap="sm" className="w-fit text-sm">
        <span className="text-muted-foreground">Cookbook</span>
        <select
          className="h-8 rounded-md border bg-background px-2 text-sm"
          value={cookbookId}
          onChange={(e) => setCookbookId(e.target.value)}
        >
          <option value="">All cookbooks</option>
          {cookbooks?.map((c) => (
            <option key={c.id} value={c.id}>
              {c.book}
            </option>
          ))}
        </select>
      </Row>
      <IngredientUsagePanel
        cookbookId={cookbookId ? unsafeCookbookId(cookbookId) : undefined}
      />
    </Stack>
  );
}
