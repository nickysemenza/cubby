import { Link } from "@tanstack/react-router";
import { ArrowRight, Clock } from "lucide-react";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
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
        <AuditLogList limit={limit} showEntityLink />
      </CardContent>
    </Card>
  );
}
