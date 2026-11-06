import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";

import type { RelatednessInput } from "~/contracts/relatedness.contract";
import { EntityDisplayImagesProvider } from "~/entity/entity-media/entity-display-images";
import { relatedness } from "~/integrations/tanstack-query/generated/domains/relatedness.gen";
import { search } from "~/integrations/tanstack-query/generated/domains/search.gen";
import { EmptyState } from "~/ui/feedback/empty-state";
import { ErrorDisplay } from "~/ui/feedback/error-display";
import { Stack } from "~/ui/layout";
import { Button } from "~/ui/primitives/button";
import { Skeleton } from "~/ui/primitives/skeleton";
import { RecordList } from "~/ui/records/record-list";
import { Description } from "~/ui/text/description";

import { RelatedRecordRow } from "./related-record-row";
import { useEmbeddingReadinessPoll } from "./use-embedding-readiness-poll";

/** Shared detail section; no entity-specific recommendation or suggestion adapter. */
export function RelatednessRail({ entity, id }: RelatednessInput) {
  const [visibleCount, setVisibleCount] = useState(12);
  const poll = useEmbeddingReadinessPoll(`${entity}:${id}`);
  const query = useQuery({
    ...relatedness.forEntity.queryOptions({ entity, id }),
    refetchInterval: poll.refetchInterval,
  });
  const refresh = useMutation(search.requestEmbeddingRefresh.mutationOptions());
  const status = query.data?.status;
  const { notifyStatus } = poll;
  useEffect(() => {
    notifyStatus(status);
  }, [status, notifyStatus]);
  const visibleItems = useMemo(
    () => query.data?.items.slice(0, visibleCount),
    [query.data, visibleCount],
  );
  const imageRefs = useMemo(
    () =>
      visibleItems?.map((item) => ({
        entityKind: item.entity,
        entityId: item.shortcode,
      })) ?? [],
    [visibleItems],
  );
  return (
    <Stack gap="sm">
      {query.isPending ? <Skeleton className="h-12 w-full" /> : null}
      {query.error ? (
        <ErrorDisplay
          error={query.error}
          title="related records"
          onRetry={() => {
            void query.refetch();
          }}
        />
      ) : null}
      {refresh.error ? <ErrorDisplay error={refresh.error} /> : null}
      {status === "unavailable" ? (
        <Description size="xs">
          Similarity is unavailable until embeddings are configured.
        </Description>
      ) : null}
      {status === "stale" || status === "uncomputed" ? (
        <>
          <Description size="xs">
            {status === "stale"
              ? "Similarity index is incomplete or stale."
              : "Similarity index has not been computed."}
          </Description>
          <Button
            variant="outline"
            disabled={refresh.isPending || poll.isPolling}
            onClick={() =>
              refresh.mutate(
                { entityKind: entity, entityId: id },
                {
                  onSuccess: () => {
                    poll.start();
                    void query.refetch();
                  },
                },
              )
            }
          >
            {refresh.isPending
              ? "Requesting index…"
              : poll.isPolling
                ? "Indexing…"
                : "Index now"}
          </Button>
        </>
      ) : null}
      {poll.timedOut ? (
        <Button
          variant="outline"
          onClick={() => poll.checkAgain(query.refetch)}
        >
          Still indexing — check again
        </Button>
      ) : null}
      <EntityDisplayImagesProvider refs={imageRefs}>
        {visibleItems?.length ? (
          <RecordList aria-label="Related records">
            {visibleItems.map((item) => (
              <RelatedRecordRow key={item.shortcode} item={item} />
            ))}
          </RecordList>
        ) : null}
      </EntityDisplayImagesProvider>
      {(query.data?.items.length ?? 0) > visibleCount ? (
        <Button
          variant="outline"
          onClick={() => setVisibleCount((count) => count + 12)}
        >
          Show more records
        </Button>
      ) : null}
      {status === "ready" && query.data?.items.length === 0 ? (
        <EmptyState size="inline">No related records yet.</EmptyState>
      ) : null}
    </Stack>
  );
}
