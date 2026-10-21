import { workQueueHouseholdInput } from "@cubby/schemas/work-queue";
import { CURRENT_MEMBER_FILTER } from "@cubby/shared";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";

import {
  suggestionsSearch,
  WorkRowLink,
  workRowType,
} from "~/features/work-queue/work-row-link";
import { workQueue } from "~/integrations/tanstack-query/generated/catalog.gen";
import { formatCount } from "~/lib/number-format";
import { CurrencyValue } from "~/ui/common/currency-value";
import { EmptyState } from "~/ui/feedback/empty-state";
import { ErrorDisplay } from "~/ui/feedback/error-display";
import { useHydrated } from "~/ui/hooks/use-hydrated";
import { Section } from "~/ui/layout";
import { Button } from "~/ui/primitives/button";

import { HomeList, HomeRow, HomeRowsLoading } from "./home-list";
import { ProblemsRow } from "./problems-row";

/**
 * Work a member must decide (the queue's Review view) routed to me or to
 * either member. The strip's count and the list share this one read.
 */
const NEEDS_YOU_INPUT = workQueueHouseholdInput.parse({
  view: "review",
  waitingFor: CURRENT_MEMBER_FILTER,
  pageSize: 3,
});

const NEEDS_YOU_SEARCH = {
  view: "review",
  waitingFor: CURRENT_MEMBER_FILTER,
} as const;

/** The queue read is client-only so Home's first paint never waits on it. */
export function useNeedsYou() {
  const hydrated = useHydrated();
  return useQuery({
    ...workQueue.list.queryOptions(NEEDS_YOU_INPUT),
    enabled: hydrated,
  });
}

export function NeedsYou() {
  const needsYou = useNeedsYou();
  const rows = needsYou.data?.items ?? [];
  const total = needsYou.data?.meta.totalCount;
  return (
    <Section
      title="Needs you"
      headingAs="h2"
      ruled
      count={total === undefined ? undefined : formatCount(total)}
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
          {rows.length === 0 && (
            <EmptyState size="inline" className="mt-2">
              Nothing is waiting on you.
            </EmptyState>
          )}
          <HomeList label="Needs you">
            {rows.map((row) => {
              const type = workRowType(row);
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
                        render={<Link to="/suggestions" search={suggestions} />}
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
                  {type && <span className="shrink-0">{type}</span>}
                  <WorkRowLink row={row} />
                  <span className="min-w-0 truncate text-muted-foreground">
                    {row.reason}
                  </span>
                </HomeRow>
              );
            })}
            <ProblemsRow />
          </HomeList>
        </>
      )}
    </Section>
  );
}
