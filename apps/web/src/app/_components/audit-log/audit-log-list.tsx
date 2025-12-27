"use client";

import { useInfiniteQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { Button } from "~/components/ui/button";
import type { AuditEntityType } from "~/server/repo/audit-log";
import { useTRPC } from "~/trpc/react";
import { AuditLogEntryComponent } from "./audit-log-entry";

interface AuditLogListProps {
  entityType?: AuditEntityType;
  entityId?: string;
  showEntityLink?: boolean;
}

export function AuditLogList({
  entityType,
  entityId,
  showEntityLink = true,
}: AuditLogListProps) {
  const trpc = useTRPC();
  const { data, fetchNextPage, hasNextPage, isFetchingNextPage, isLoading } =
    useInfiniteQuery(
      trpc.auditLog.list.infiniteQueryOptions(
        {
          entityType,
          entityId,
          limit: 20,
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
      <div className="py-8 text-center text-muted-foreground">
        No activity yet
      </div>
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
