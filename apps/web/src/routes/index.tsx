import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { PantryValueCard } from "~/app/_components/home/PantryValueCard";
import { QuickActionsCard } from "~/app/_components/home/QuickActionsCard";
import { RecentActivityFeed } from "~/app/_components/home/RecentActivityFeed";
import EntityCount from "~/app/_components/homepage/entitycount";
import { PageWrapper } from "~/components/layout/page-wrapper";
import { Eyebrow } from "~/components/ui/eyebrow";
import { authClient } from "~/lib/auth-client";

export const Route = createFileRoute("/")({
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
