import type { AuditEntityType } from "@cubby/schemas/audit";
import type { AuditSource } from "@cubby/schemas/context";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Activity } from "lucide-react";
import { Row } from "~/components/layout";
import { Timeline } from "~/components/reui/timeline";
import { Button } from "~/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyIcon,
  EmptyTitle,
} from "~/components/ui/empty";
import { Spinner } from "~/components/ui/spinner";
import { useHydrated } from "~/hooks/useHydrated";
import { useTRPC } from "~/integrations/trpc/react";
import { authClient } from "~/lib/auth-client";
import { AuditLogEntryComponent } from "./audit-log-entry";

interface AuditLogListProps {
  entityType?: AuditEntityType;
  entityId?: string;
  source?: AuditSource;
  showEntityLink?: boolean;
  /** Number of entries per page (default 20) */
  limit?: number;
  /** "ledger" renders glanceable single-line entries (home feed) */
  variant?: "default" | "ledger";
}

export function AuditLogList({
  entityType,
  entityId,
  source,
  showEntityLink = true,
  limit = 20,
  variant = "default",
}: AuditLogListProps) {
  const trpc = useTRPC();
  const session = authClient.useSession();
  // Hydration gate: the session store can resolve before React hydrates, so
  // branching on it alone makes the first client render diverge from SSR.
  // Gating the query on auth also stops it from firing Unauthorized when
  // signed out (this list renders on the public home page).
  const hydrated = useHydrated();
  const isAuthenticated = hydrated && !!session.data?.user;
  const { data, fetchNextPage, hasNextPage, isFetchingNextPage, isLoading } =
    useInfiniteQuery({
      ...trpc.auditLog.list.infiniteQueryOptions(
        {
          entityType,
          entityId,
          source,
          limit,
        },
        {
          getNextPageParam: (lastPage) => lastPage.nextCursor,
        },
      ),
      enabled: isAuthenticated,
    });

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

  const entries = data?.pages.flatMap((page) => page.entries) ?? [];

  if (entries.length === 0) {
    return (
      <Empty variant="minimal" className="py-6">
        <EmptyIcon icon={Activity} />
        <EmptyTitle>No activity yet</EmptyTitle>
        <EmptyDescription>Actions you take will appear here</EmptyDescription>
      </Empty>
    );
  }

  return (
    <div>
      <Timeline mode="chronological">
        {entries.map((entry, index) => (
          <AuditLogEntryComponent
            key={`${entry.entityType}:${entry.entityId}:${entry.action}:${entry.createdAt.toISOString()}`}
            entry={entry}
            step={index + 1}
            showEntityLink={showEntityLink}
            variant={variant}
          />
        ))}
      </Timeline>

      {hasNextPage && (
        <Row justify="center" className="pt-4">
          <Button
            variant="outline"
            size="sm"
            onClick={() => fetchNextPage()}
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
