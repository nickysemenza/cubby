import { createFileRoute } from "@tanstack/react-router";
import { QuickActionsCard } from "~/app/_components/home/QuickActionsCard";
import { RecentActivityFeed } from "~/app/_components/home/RecentActivityFeed";
import EntityCount from "~/app/_components/homepage/entitycount";
import { PageWrapper } from "~/components/layout/page-wrapper";

export const Route = createFileRoute("/")({
  component: Home,
});

function Home() {
  return (
    <PageWrapper className="gradient-mesh space-y-4">
      {/* Warm greeting */}
      <div className="page-header-accent pb-2">
        <p className="mb-1 font-medium text-muted-foreground text-xs uppercase tracking-[0.18em]">
          Keep everything in its place
        </p>
        <h1 className="font-bold font-heading text-2xl tracking-tight sm:text-4xl">
          Welcome home.
        </h1>
      </div>

      {/* Entity Stats */}
      <EntityCount />

      {/* Two-column layout for Activity and Quick Actions. On mobile, surface
          the create-actions above the read-only activity feed. */}
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="lg:order-2">
          <QuickActionsCard />
        </div>
        <div className="lg:order-1">
          <RecentActivityFeed limit={4} />
        </div>
      </div>
    </PageWrapper>
  );
}
