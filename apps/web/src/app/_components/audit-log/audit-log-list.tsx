import type { AuditEntityType } from "@cubby/schemas/audit";
import type { AuditChannel } from "@cubby/schemas/context";
import { PulseIcon } from "@phosphor-icons/react/dist/csr/Pulse";
import { WarningCircleIcon } from "@phosphor-icons/react/dist/csr/WarningCircle";
import { useInfiniteQuery } from "@tanstack/react-query";
import { uniqBy } from "es-toolkit";
import { useMemo } from "react";

import { Row } from "~/components/layout";
import { AuditTimeline } from "~/components/reui/timeline";
import { Button } from "~/components/ui/button";
import {
  Empty,
  EmptyActions,
  EmptyDescription,
  EmptyIcon,
  EmptyTitle,
} from "~/components/ui/empty";
import { Spinner } from "~/components/ui/spinner";
import { useHydrated } from "~/hooks/useHydrated";
import { auditLog, auditLogListOptions } from "~/lib/audit-log.functions";
import { authClient } from "~/lib/auth-client";
import { getErrorMessage } from "~/lib/error-utils";

import { AuditLogEntryComponent } from "./audit-log-entry";

export interface AuditLogListOperations {
  list: typeof auditLog.list;
}

export interface AuditLogSession {
  isAuthenticated: boolean;
  isPending: boolean;
}

const productionOperations: AuditLogListOperations = {
  list: auditLog.list,
};

interface AuditLogListProps {
  entityType?: AuditEntityType;
  entityId?: string;
  /** Everything one Run wrote (a RUN- shortcode). */
  runId?: string;
  channel?: AuditChannel;
  showEntityLink?: boolean;
  /** Number of entries per page (default 20) */
  limit?: number;
  /** "ledger" renders glanceable single-line entries (home feed) */
  variant?: "default" | "ledger";
  /** Remote audit-log descriptor; browser tests supply an in-memory transport. */
  operations?: AuditLogListOperations;
  /** Auth state is an external browser boundary, independent of the log query. */
  session?: AuditLogSession;
}

export function AuditLogList({
  entityType,
  entityId,
  runId,
  channel,
  showEntityLink = true,
  limit = 20,
  variant = "default",
  operations = productionOperations,
  session: suppliedSession,
}: AuditLogListProps) {
  const authSession = authClient.useSession();
  // Hydration gate: the session store can resolve before React hydrates, so
  // branching on it alone makes the first client render diverge from SSR.
  // Gating the query on auth also stops it from firing Unauthorized when
  // signed out (this list renders on the public home page).
  const hydrated = useHydrated();
  const session = suppliedSession ?? {
    isAuthenticated: hydrated && !!authSession.data?.user,
    isPending: authSession.isPending,
  };
  const {
    data,
    error,
    fetchNextPage,
    hasNextPage,
    isError,
    isFetchingNextPage,
    isLoading,
    refetch,
  } = useInfiniteQuery({
    ...auditLogListOptions(
      {
        entityType,
        entityId,
        runId,
        channel,
        limit,
      },
      {
        getNextPageParam: (lastPage) => lastPage.nextCursor,
      },
      operations.list,
    ),
    enabled: session.isAuthenticated,
  });

  const entries = useMemo(
    () =>
      uniqBy(
        data?.pages.flatMap((page) => page.entries) ?? [],
        (entry) => entry.entryKey,
      ),
    [data],
  );

  // Pre-hydration renders the empty state on both sides; isPending only
  // matters after hydration, where it avoids flashing "No activity yet"
  // while the session is still resolving for a signed-in user.
  if (isLoading || (hydrated && session.isPending)) {
    return (
      <Row align="center" justify="center" className="py-6">
        <Spinner size="md" className="text-muted-foreground" />
      </Row>
    );
  }

  if (isError) {
    return (
      <Empty variant="minimal" className="py-6">
        <EmptyIcon icon={WarningCircleIcon} />
        <EmptyTitle>Couldn&apos;t load activity</EmptyTitle>
        <EmptyDescription>
          {getErrorMessage(error) || "Try again to load recent activity."}
        </EmptyDescription>
        <EmptyActions>
          <Button
            type="button"
            variant="outline"
            className="h-11 sm:h-7"
            onClick={() => refetch()}
          >
            Retry
          </Button>
        </EmptyActions>
      </Empty>
    );
  }

  if (entries.length === 0) {
    return (
      <Empty variant="minimal" className="py-6">
        <EmptyIcon icon={PulseIcon} />
        <EmptyTitle>No activity yet</EmptyTitle>
        <EmptyDescription>Actions you take will appear here</EmptyDescription>
      </Empty>
    );
  }

  return (
    <div>
      <AuditTimeline>
        {entries.map((entry, index) => (
          <AuditLogEntryComponent
            key={entry.entryKey}
            entry={entry}
            step={index + 1}
            showEntityLink={showEntityLink}
            variant={variant}
          />
        ))}
      </AuditTimeline>

      {hasNextPage && (
        <Row justify="center" className="pt-4">
          <Button
            variant="outline"
            size="sm"
            onClick={() => fetchNextPage({ cancelRefetch: false })}
            disabled={isFetchingNextPage}
          >
            {isFetchingNextPage ? (
              <>
                <Spinner className="mr-2" />
                Loading...
              </>
            ) : (
              "Load more"
            )}
          </Button>
        </Row>
      )}
    </div>
  );
}
