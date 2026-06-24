import { createFileRoute, redirect } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import {
  PANTRY_VALUE_OPTS,
  PantryValueCard,
} from "~/app/_components/home/PantryValueCard";
import { QuickActionsCard } from "~/app/_components/home/QuickActionsCard";
import { RecentActivityFeed } from "~/app/_components/home/RecentActivityFeed";
import EntityCount, {
  DASHBOARD_COUNT_OPTS,
} from "~/app/_components/homepage/entitycount";
import { PageWrapper } from "~/components/layout/page-wrapper";
import { Eyebrow } from "~/components/ui/eyebrow";
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
  // Warm the count-card queries during route load so they're already in flight
  // when EntityCount mounts (most useful on client-side navigation). Inputs must
  // match EntityCount's exactly (DASHBOARD_COUNT_OPTS) or the cache won't be
  // reused. Non-blocking `void prefetch` (not awaited ensure): the SSR tRPC
  // client targets localhost, which is unreachable on CF Workers — so awaiting
  // here would break prod. EntityCount's own gate + skeleton covers cold loads.
  loader: ({ context }) => {
    const { queryClient, trpc } = context;
    const o = DASHBOARD_COUNT_OPTS;
    void queryClient.prefetchQuery(trpc.location.list.queryOptions(o));
    void queryClient.prefetchQuery(trpc.product.list.queryOptions(o));
    void queryClient.prefetchQuery(trpc.inventory.list.queryOptions(o));
    void queryClient.prefetchQuery(trpc.recipe.list.queryOptions(o));
    void queryClient.prefetchQuery(trpc.ingredient.list.queryOptions(o));
    void queryClient.prefetchQuery(trpc.image.list.queryOptions(o));
    void queryClient.prefetchQuery(trpc.usda.list.queryOptions(o));
    void queryClient.prefetchQuery({
      ...trpc.problems.getAllProblems.queryOptions(),
      staleTime: 5 * 60 * 1000,
    });
    // Warm the pantry-value card's heavier inventory.list(1000) query so the
    // card paints without a spinner. Same input as the card (PANTRY_VALUE_OPTS).
    void queryClient.prefetchQuery(
      trpc.inventory.list.queryOptions(PANTRY_VALUE_OPTS),
    );
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
    <PageWrapper className="gradient-mesh space-y-4">
      {/* Warm greeting with a ledger-style date stamp */}
      <div className="page-header-accent flex items-end justify-between pb-2">
        <div>
          <Eyebrow className="mb-1 font-medium tracking-[0.18em]">
            Keep everything in its place
          </Eyebrow>
          <h1 className="font-bold font-heading text-2xl tracking-tight sm:text-4xl">
            {greeting}
          </h1>
        </div>
        {now && (
          <p className="hidden font-mono text-2xs text-muted-foreground uppercase sm:block">
            {now.toLocaleDateString("en-US", {
              weekday: "short",
              day: "2-digit",
              month: "short",
              year: "numeric",
            })}
          </p>
        )}
      </div>

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
    </PageWrapper>
  );
}
