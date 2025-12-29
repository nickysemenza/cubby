import { useInfiniteQuery } from "@tanstack/react-query";
import { Activity, Loader2 } from "lucide-react";
import { Button } from "~/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyIcon,
  EmptyTitle,
} from "~/components/ui/empty";
import type { AuditEntityType } from "~/server/repo/audit-log";
import { useTRPC } from "~/trpc/react";
import { AuditLogEntryComponent } from "./audit-log-entry";

interface AuditLogListProps {
  entityType?: AuditEntityType;
  entityId?: string;
  showEntityLink?: boolean;
  /** Number of entries per page (default 20) */
  limit?: number;
}

export function AuditLogList({
  entityType,
  entityId,
  showEntityLink = true,
  limit = 20,
}: AuditLogListProps) {
  const trpc = useTRPC();
  const { data, fetchNextPage, hasNextPage, isFetchingNextPage, isLoading } =
    useInfiniteQuery(
      trpc.auditLog.list.infiniteQueryOptions(
        {
          entityType,
          entityId,
          limit,
        },
        {
          getNextPageParam: (lastPage) => lastPage.nextCursor,
        },
      ),
    );

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
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
      <div className="divide-y">
        {entries.map((entry) => (
          <AuditLogEntryComponent
            key={entry.id}
            entry={entry}
            showEntityLink={showEntityLink}
          />
        ))}
      </div>

      {hasNextPage && (
        <div className="flex justify-center pt-4">
          <Button
            variant="outline"
            size="sm"
            onClick={() => fetchNextPage()}
            disabled={isFetchingNextPage}
          >
            {isFetchingNextPage ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Loading...
              </>
            ) : (
              "Load more"
            )}
          </Button>
        </div>
      )}
    </div>
  );
}
