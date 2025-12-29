import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Activity, ArrowRight, Clock } from "lucide-react";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import {
  Empty,
  EmptyDescription,
  EmptyIcon,
  EmptyTitle,
} from "~/components/ui/empty";
import { Spinner } from "~/components/ui/spinner";
import { useTRPC } from "~/trpc/react";
import { AuditLogEntryComponent } from "../audit-log/audit-log-entry";

interface RecentActivityFeedProps {
  /** Maximum number of entries to show */
  limit?: number;
}

/**
 * Compact recent activity feed for the home page.
 * Shows the latest actions with a link to full activity history.
 */
export function RecentActivityFeed({ limit = 5 }: RecentActivityFeedProps) {
  const trpc = useTRPC();
  const { data, isLoading } = useQuery(
    trpc.auditLog.list.queryOptions({
      limit,
    }),
  );

  const entries = data?.entries ?? [];

  return (
    <Card className="fade-in slide-in-from-bottom-2 flex animate-in flex-col duration-300">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Clock className="h-4 w-4 text-muted-foreground" />
            <CardTitle className="text-base">Recent Activity</CardTitle>
          </div>
          <Link to="/activity">
            <Button variant="ghost" size="sm" className="h-7 gap-1 text-xs">
              View all
              <ArrowRight className="h-3 w-3" />
            </Button>
          </Link>
        </div>
      </CardHeader>
      <CardContent className="flex-1">
        {isLoading ? (
          <div className="flex items-center justify-center py-8">
            <Spinner />
          </div>
        ) : entries.length === 0 ? (
          <Empty variant="minimal" className="py-6">
            <EmptyIcon icon={Activity} />
            <EmptyTitle>No activity yet</EmptyTitle>
            <EmptyDescription>
              Actions you take will appear here
            </EmptyDescription>
          </Empty>
        ) : (
          <div className="divide-y">
            {entries.map((entry) => (
              <AuditLogEntryComponent
                key={entry.id}
                entry={entry}
                showEntityLink
              />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
