import { createFileRoute } from "@tanstack/react-router";
import { QuickActionsCard } from "~/app/_components/home/QuickActionsCard";
import { RecentActivityFeed } from "~/app/_components/home/RecentActivityFeed";
import EntityCount from "~/app/_components/homepage/entitycount";

export const Route = createFileRoute("/")({
  component: Home,
});

function Home() {
  return (
    <div className="space-y-6">
      {/* Entity Stats */}
      <section>
        <h2 className="mb-3 font-medium text-muted-foreground text-sm">
          Overview
        </h2>
        <EntityCount />
      </section>

      {/* Two-column layout for Activity and Quick Actions */}
      <div className="grid gap-6 lg:grid-cols-2">
        <RecentActivityFeed limit={6} />
        <QuickActionsCard />
      </div>
    </div>
  );
}
