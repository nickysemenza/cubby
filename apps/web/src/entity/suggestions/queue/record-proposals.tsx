import type { SuggestionListRow } from "@cubby/schemas/suggestion-list";
import { useQuery } from "@tanstack/react-query";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { entityDetailLink, isBrowserRoutedEntity } from "~/entity/entities";
import { suggestions } from "~/integrations/tanstack-query/generated/domains/suggestions.gen";
import { useSectionEmpty } from "~/ui/data-table/detail-section-state";
import { ErrorDisplay } from "~/ui/feedback/error-display";
import { useHydratedLoading } from "~/ui/hooks/use-hydrated";
import { Stack } from "~/ui/layout";
import { Button } from "~/ui/primitives/button";
import { RecordList, RecordRow } from "~/ui/records/record-list";

import { useAcceptClean } from "./accept-clean";
import { ScopedListPager } from "./scoped-list-pager";
import {
  MobileEvidenceDisclosure,
  SuggestionActions,
} from "./suggestion-actions";
import { SuggestionEvidence } from "./suggestion-evidence";
import { SuggestionReviewProvider } from "./suggestion-review-context";
import { FAMILY_LABEL, RecordLink, WhatChanges } from "./suggestion-values";

/** Record surfaces are scopes of the queue, with its actions and bulk authority. */
export function RecordProposals({ id }: { id: string }) {
  const navigate = useNavigate();
  const pathname = useLocation({ select: (location) => location.pathname });
  const [offset, setOffset] = useState(0);
  const query = useQuery(
    suggestions.list.queryOptions({ recordIds: [id], offset, limit: 50 }),
  );
  const loading = useHydratedLoading(query.isLoading);
  const accept = useAcceptClean(
    (assessmentId) =>
      query.data?.items.find((row) => row.assessmentId === assessmentId)
        ?.record,
  );
  const clean = query.data?.meta.cleanCount ?? 0;
  useSectionEmpty(query.isSuccess && query.data.items.length === 0);
  return (
    <section aria-label="Pending suggestions">
      <Stack gap="sm">
        {query.error ? (
          <ErrorDisplay
            error={query.error}
            title="pending suggestions"
            onRetry={() => void query.refetch()}
          />
        ) : null}
        {clean > 0 ? (
          <Button
            size="sm"
            variant="outline"
            disabled={accept.running}
            onClick={() =>
              accept.confirm({
                label: "This record",
                count: clean,
                filters: { recordIds: [id] },
              })
            }
          >
            Accept {clean} clean
          </Button>
        ) : null}
        {accept.dialogs}
        <SuggestionReviewProvider
          scope={id}
          onApplied={async ({ source, destination }) => {
            if (
              source.entityId === id &&
              destination.entityId !== id &&
              pathname.endsWith(`/${id}`) &&
              destination.entityKind !== "usda-food" &&
              isBrowserRoutedEntity(destination.entityKind)
            )
              await navigate({
                ...entityDetailLink(
                  destination.entityKind,
                  destination.entityId,
                ),
                replace: true,
              });
          }}
        >
          <RecordList
            aria-label="Record suggestions"
            state={loading ? { status: "pending" } : { status: "success" }}
            empty={
              query.error && !query.data
                ? "Pending suggestions are unavailable."
                : query.error
                  ? "No known pending suggestions."
                  : "No pending suggestions."
            }
          >
            {query.data?.items.map((row) => (
              <ScopedProposal key={row.id} row={row} />
            ))}
          </RecordList>
        </SuggestionReviewProvider>
        {query.data ? (
          <ScopedListPager
            offset={offset}
            itemCount={query.data.items.length}
            totalCount={query.data.meta.totalCount}
            nextOffset={query.data.next ? offset + 50 : null}
            onOffsetChange={setOffset}
          />
        ) : null}
      </Stack>
    </section>
  );
}
function ScopedProposal({ row }: { row: SuggestionListRow }) {
  return (
    <RecordRow
      primary={<RecordLink record={row.record} />}
      secondary={<WhatChanges row={row} />}
      trailing={FAMILY_LABEL[row.family]}
      actions={<SuggestionActions suggestion={row} />}
      detail={
        <MobileEvidenceDisclosure row={row}>
          <SuggestionEvidence row={row} />
        </MobileEvidenceDisclosure>
      }
    />
  );
}
