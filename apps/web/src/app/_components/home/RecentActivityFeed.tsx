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
      title="Recent Activity"
      action={
        <Link to="/activity">
          <Button variant="ghost" size="sm" className="h-7 gap-1 text-xs">
            View all
            <ArrowRight className="h-3 w-3" />
          </Button>
        </Link>
      }
    >
      <AuditLogList limit={limit} showEntityLink />
    </DashboardCard>
  );
}
