import { ArrowRightIcon as ArrowRight } from "@phosphor-icons/react/dist/csr/ArrowRight";
import { ClockIcon as Clock } from "@phosphor-icons/react/dist/csr/Clock";
import { Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";

import { DashboardCard } from "~/components/layout/dashboard-card";
import { Button } from "~/components/ui/button";
import { Skeleton } from "~/components/ui/skeleton";

import { AuditLogList } from "../audit-log/audit-log-list";
import type {
  AuditLogListOperations,
  AuditLogSession,
} from "../audit-log/audit-log-list";

export interface RecentActivityFeedOperations {
  readonly auditLog: AuditLogListOperations;
  readonly session: AuditLogSession;
}

export interface ViewportObservationPort {
  observe(host: Element, onEnter: () => void): () => void;
}

const browserViewportObservation: ViewportObservationPort = {
  observe(host, onEnter) {
    const Observer = globalThis.IntersectionObserver;
    if (Observer === undefined) {
      onEnter();
      return () => undefined;
    }
    const observer = new Observer(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        onEnter();
        observer.disconnect();
      },
      { rootMargin: "500px" },
    );
    observer.observe(host);
    return () => observer.disconnect();
  },
};

interface RecentActivityFeedProps {
  /** Maximum number of entries to show */
  limit?: number;
}

/**
 * Compact recent activity feed for the home page.
 * Shows the latest actions with a link to full activity history.
 */
export function RecentActivityFeed({
  limit = 5,
  operations,
  viewport = browserViewportObservation,
}: RecentActivityFeedProps & {
  /** Audit operation/auth boundaries for browser tests. */
  operations?: RecentActivityFeedOperations;
  /** Browser viewport observation, injected only where the DOM API is absent. */
  viewport?: ViewportObservationPort;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    return viewport.observe(host, () => setEnabled(true));
  }, [viewport]);

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
          <AuditLogList
            limit={limit}
            showEntityLink
            variant="ledger"
            operations={operations?.auditLog}
            session={operations?.session}
          />
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
