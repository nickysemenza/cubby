import type { AuditEntityType } from "@cubby/schemas/audit";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Activity } from "lucide-react";
import { Button } from "~/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyIcon,
  EmptyTitle,
} from "~/components/ui/empty";
import { Spinner } from "~/components/ui/spinner";
import { useTRPC } from "~/trpc/react";
import { AuditLogEntryComponent } from "./audit-log-entry";

interface AuditLogListProps {
  entityType?: AuditEntityType;
  entityId?: string;
  showEntityLink?: boolean;
  /** Number of entries per page (default 20) */
  limit?: number;
  /** "ledger" renders glanceable single-line entries (home feed) */
  variant?: "default" | "ledger";
}

export function AuditLogList({
  entityType,
  entityId,
  showEntityLink = true,
  limit = 20,
  variant = "default",
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
        <Spinner size="md" className="text-muted-foreground" />
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
            variant={variant}
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
                <Spinner className="mr-2" />
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
