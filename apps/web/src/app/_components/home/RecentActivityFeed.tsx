import { Link } from "@tanstack/react-router";
import { ArrowRight, Clock } from "lucide-react";
import { DashboardCard } from "~/components/layout/dashboard-card";
import { Button } from "~/components/ui/button";
import { AuditLogList } from "../audit-log/audit-log-list";

interface RecentActivityFeedProps {
  /** Maximum number of entries to show */
  limit?: number;
}

/**
 * Compact recent activity feed for the home page.
 * Shows the latest actions with a link to full activity history.
 */
export function RecentActivityFeed({ limit = 5 }: RecentActivityFeedProps) {
  return (
    <DashboardCard
      icon={Clock}
      title="Recent activity"
      action={
        // `render` keeps this one element — a <button> inside an <a> is
        // invalid HTML and produced two tab stops for one destination.
        <Button
          render={<Link to="/activity" />}
          nativeButton={false}
          variant="ghost"
          size="sm"
          className="h-11 gap-1 text-xs sm:h-7"
        >
          View all
          <ArrowRight className="size-3" />
        </Button>
      }
    >
      <AuditLogList limit={limit} showEntityLink variant="ledger" />
    </DashboardCard>
  );
}
