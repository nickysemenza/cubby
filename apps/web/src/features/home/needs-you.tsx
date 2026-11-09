import { NEEDS_YOU_FILTERS, workQueueInput } from "@cubby/schemas/work-queue";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";

import { EntityDisplayImagesProvider } from "~/entity/entity-media/entity-display-images";
import {
  hasIncompleteWorkInputs,
  WorkInputStatus,
} from "~/features/work-queue/work-input-status";
import {
  suggestionsSearch,
  WorkRowLink,
} from "~/features/work-queue/work-row-link";
import { workQueue } from "~/integrations/tanstack-query/generated/domains/workQueue.gen";
import { formatCount } from "~/lib/number-format";
import { EmptyState } from "~/ui/feedback/empty-state";
import { ErrorDisplay } from "~/ui/feedback/error-display";
import { QuerySection } from "~/ui/feedback/query-section";
import { Section } from "~/ui/layout";
import { Button } from "~/ui/primitives/button";
import { CurrencyValue } from "~/ui/values/currency-value";
import { DenseCellContext } from "~/ui/values/stacked-value";

import { HomeList, HomeRow, HomeRowsLoading } from "./home-list";

/**
 * Work a member must decide that I own, shared work included: the same
 * population as the Work page and the sidebar. The strip's count and the list
 * share this one read.
 */
export const NEEDS_YOU_INPUT = workQueueInput.parse({
  ...NEEDS_YOU_FILTERS,
  pageSize: 3,
});

const NEEDS_YOU_SEARCH = {
  ...NEEDS_YOU_FILTERS,
  reasonExclude: NEEDS_YOU_FILTERS.reasonExclude.join(","),
};

/** The key-number strip shares the streamed section's query. */
export function useNeedsYou() {
  return useQuery({
    ...workQueue.queue.queryOptions(NEEDS_YOU_INPUT),
  });
}

export function NeedsYou() {
  return (
    <QuerySection
      title="work that needs you"
      fallback={
        <Section
          title="Needs you"
          headingAs="h2"
          ruled
          actions={
            <Link to="/work-queue" search={NEEDS_YOU_SEARCH}>
              Work queue
            </Link>
          }
        >
          <HomeRowsLoading label="Loading work that needs you" />
        </Section>
      }
    >
      <NeedsYouContent />
    </QuerySection>
  );
}

function NeedsYouContent() {
  const needsYou = useSuspenseQuery(
    workQueue.queue.queryOptions(NEEDS_YOU_INPUT),
  );
  const rows = needsYou.data?.items ?? [];
  const total = needsYou.data?.meta.totalCount;
  const incomplete = hasIncompleteWorkInputs(needsYou.data?.meta);
  return (
    <Section
      title="Needs you"
      headingAs="h2"
      ruled
      count={total === undefined || incomplete ? undefined : formatCount(total)}
      actions={
        <Link to="/work-queue" search={NEEDS_YOU_SEARCH}>
          Work queue
        </Link>
      }
    >
      {needsYou.isError ? (
        <ErrorDisplay
          error={needsYou.error}
          title="work that needs you"
          onRetry={() => void needsYou.refetch()}
          className="mt-2"
        />
      ) : needsYou.data === undefined ? (
        <HomeRowsLoading label="Loading work that needs you" />
      ) : (
        <>
          <WorkInputStatus meta={needsYou.data?.meta} />
          {rows.length === 0 && (
            <EmptyState size="inline" className="mt-2">
              {incomplete
                ? "No known work while checks finish updating."
                : "Nothing is waiting on you."}
            </EmptyState>
          )}
          <EntityDisplayImagesProvider
            refs={rows.flatMap((row) =>
              row.entity && row.id
                ? [{ entityKind: row.entity, entityId: row.id }]
                : [],
            )}
          >
            <DenseCellContext.Provider value={{ linksTo: null }}>
              <HomeList label="Needs you">
                {rows.map((row) => {
                  const suggestions = suggestionsSearch(row);
                  return (
                    <HomeRow
                      key={row.key}
                      trailing={
                        suggestions ? (
                          <Button
                            variant="outline"
                            size="sm"
                            nativeButton={false}
                            render={
                              <Link to="/suggestions" search={suggestions} />
                            }
                            className="max-md:min-h-11"
                          >
                            Review
                          </Button>
                        ) : row.amount === null ? null : (
                          <CurrencyValue
                            value={row.amount}
                            className="font-mono text-foreground-strong"
                          />
                        )
                      }
                    >
                      <WorkRowLink row={row} />
                      <span className="max-w-1/2 shrink-0 truncate text-muted-foreground">
                        {row.reason}
                      </span>
                    </HomeRow>
                  );
                })}
                <ProblemsRow
                  count={needsYou.data.meta.viewCounts.problems ?? 0}
                />
              </HomeList>
            </DenseCellContext.Provider>
          </EntityDisplayImagesProvider>
        </>
      )}
    </Section>
  );
}

/** The Problems view's count from the same read, shown only when nonzero. */
function ProblemsRow({ count }: { count: number }) {
  if (count === 0) return null;
  return (
    <HomeRow>
      <Link
        to="/work-queue"
        search={{ view: "problems" }}
        className="min-w-0 truncate font-medium text-foreground underline-offset-2 outline-none hover:text-primary hover:underline focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="font-mono tabular-nums">{formatCount(count)} </span>
        <span>{count === 1 ? "problem needs" : "problems need"} attention</span>
      </Link>
    </HomeRow>
  );
}
