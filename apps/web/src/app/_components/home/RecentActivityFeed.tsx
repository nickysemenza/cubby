import { Link } from "@tanstack/react-router";
import { ArrowRight, Clock } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { DashboardCard } from "~/components/layout/dashboard-card";
import { Button } from "~/components/ui/button";
import { Skeleton } from "~/components/ui/skeleton";
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
  const hostRef = useRef<HTMLDivElement>(null);
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    if (typeof IntersectionObserver === "undefined") {
      setEnabled(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        setEnabled(true);
        observer.disconnect();
      },
      { rootMargin: "500px" },
    );
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  return (
    <div ref={hostRef}>
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
        {enabled ? (
          <AuditLogList limit={limit} showEntityLink variant="ledger" />
        ) : (
          <div className="space-y-2" data-testid="activity-placeholder">
            {Array.from(
              { length: limit },
              (_, index) => `activity-placeholder-${index}`,
            ).map((placeholderKey) => (
              <Skeleton
                key={placeholderKey}
                data-testid="activity-placeholder-row"
                className="h-11 w-full sm:h-7"
              />
            ))}
          </div>
        )}
      </DashboardCard>
    </div>
  );
}
