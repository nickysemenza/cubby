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
    <PageWrapper className="gradient-mesh space-y-6">
      {/* Warm greeting */}
      <div className="page-header-accent pb-2">
        <p className="mb-1 font-medium text-muted-foreground text-xs uppercase tracking-[0.18em]">
          Keep everything in its place
        </p>
        <h1 className="font-bold font-heading text-3xl tracking-tight sm:text-4xl">
          Welcome home.
        </h1>
      </div>

      {/* Entity Stats */}
      <section>
        <h2 className="mb-3 font-medium text-muted-foreground text-sm">
          Here's everything you're keeping
        </h2>
        <EntityCount />
      </section>

      {/* Two-column layout for Activity and Quick Actions */}
      <div className="grid gap-6 lg:grid-cols-2">
        <RecentActivityFeed limit={6} />
        <QuickActionsCard />
      </div>
    </PageWrapper>
  );
}
