import { automaticDecisionFamily } from "@cubby/schemas/automatic-decision";
import type { AutomaticDecisionRow } from "@cubby/schemas/automatic-decision";
import { suggestionReviewFamilies } from "@cubby/schemas/suggestion-review-family";
import { humanize } from "@cubby/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { usePageCount } from "~/entity/page/page";
import { ripple } from "~/integrations/tanstack-query/cache-tags";
import { suggestion as suggestionApi } from "~/integrations/tanstack-query/generated/domains/suggestion.gen";
import { suggestions } from "~/integrations/tanstack-query/generated/domains/suggestions.gen";
import { invalidateOperationTags } from "~/integrations/tanstack-query/operation-cache";
import { Picker } from "~/ui/combobox/picker";
import { useSectionEmpty } from "~/ui/data-table/detail-section-state";
import { ErrorDisplay } from "~/ui/feedback/error-display";
import { useHydratedLoading } from "~/ui/hooks/use-hydrated";
import { Stack, Row } from "~/ui/layout";
import { Disclosure } from "~/ui/layout";
import { Button } from "~/ui/primitives/button";
import { RecordList, RecordRow } from "~/ui/records/record-list";
import { Description } from "~/ui/text/description";
import { DateDisplay } from "~/ui/values/date-display";

import { ScopedListPager } from "./scoped-list-pager";
import { RecordLink } from "./suggestion-values";

const FAMILY_OPTIONS = [
  { value: "all", label: "All families" },
  ...automaticDecisionFamily.options.map((family) => ({
    value: family,
    label: suggestionReviewFamilies[family].label,
  })),
];
const REVIEW_OPTIONS = [
  { value: "all", label: "All decisions" },
  { value: "unreviewed", label: "Unreviewed" },
  { value: "reviewed", label: "Reviewed" },
  { value: "wrong", label: "Wrong" },
];

export function AutomaticDecisions({
  id,
  initialFamily = "all",
}: {
  id?: string;
  initialFamily?: string;
}) {
  const [family, setFamily] = useState(initialFamily);
  const [reviewStatus, setReviewStatus] = useState<
    "all" | "unreviewed" | "reviewed" | "wrong"
  >("all");
  const [offset, setOffset] = useState(0);
  const query = useQuery(
    suggestions.automaticDecisions.queryOptions({
      family: automaticDecisionFamily.safeParse(family).data,
      recordIds: id ? [id] : undefined,
      reviewStatus,
      offset,
      limit: 50,
    }),
  );
  const loading = useHydratedLoading(query.isLoading);
  // A record's unfiltered, empty history folds; a filter that matched nothing
  // keeps its controls, and loading or failed reads never report empty.
  useSectionEmpty(
    id !== undefined &&
      family === initialFamily &&
      reviewStatus === "all" &&
      query.isSuccess &&
      query.data.totalCount === 0,
  );
  usePageCount(id || query.isLoading ? undefined : query.data?.totalCount);
  return (
    <section aria-label="Automation history">
      <Stack gap="sm">
        <Description>
          Automatic decisions and recorded correction attempts. A held attempt
          made no change. No review is required.
        </Description>
        <Row gap="sm" className="flex-wrap">
          <Picker
            mode="choose"
            compact
            className="w-full md:w-60"
            aria-label="Automatic decision family"
            options={FAMILY_OPTIONS}
            value={family}
            onValueChange={(value) => {
              setFamily(value ?? "all");
              setOffset(0);
            }}
          />
          <Picker
            mode="choose"
            compact
            className="w-full md:w-60"
            aria-label="Automatic decision review status"
            options={REVIEW_OPTIONS}
            value={reviewStatus}
            onValueChange={(value) => {
              setReviewStatus(
                value === "unreviewed" ||
                  value === "reviewed" ||
                  value === "wrong"
                  ? value
                  : "all",
              );
              setOffset(0);
            }}
          />
        </Row>
        {query.error ? (
          <ErrorDisplay
            error={query.error}
            title="automation history"
            onRetry={() => void query.refetch()}
          />
        ) : null}
        <RecordList
          state={loading ? { status: "pending" } : { status: "success" }}
          empty="No automatic decisions or correction attempts in this scope."
        >
          {query.data?.items.map((row) => (
            <AutomaticDecision key={row.id} row={row} />
          ))}
        </RecordList>
        {query.data ? (
          <ScopedListPager
            offset={offset}
            itemCount={query.data.items.length}
            totalCount={query.data.totalCount}
            nextOffset={query.data.nextOffset}
            onOffsetChange={setOffset}
          />
        ) : null}
      </Stack>
    </section>
  );
}

export function AutomaticDecision({ row }: { row: AutomaticDecisionRow }) {
  const queryClient = useQueryClient();
  const review = useMutation(
    suggestionApi.review.mutationOptions({
      onSuccess: () => invalidateOperationTags(queryClient, ripple.suggestions),
    }),
  );
  return (
    <RecordRow
      primary={
        <Row gap="sm" className="flex-wrap">
          <span>{suggestionReviewFamilies[row.family].label}</span>
          {row.records.map((record) => (
            <RecordLink key={`${record.entity}:${record.id}`} record={record} />
          ))}
        </Row>
      }
      secondary={
        <Stack gap="sm">
          <span>{row.summary}</span>
          {!row.applicationVerified ? (
            <span className="text-xs text-muted-foreground">
              Unverified application — this saved prediction may not have been
              used.
            </span>
          ) : null}
        </Stack>
      }
      trailing={<DateDisplay timestamp={row.createdAt} />}
      actions={
        <Row gap="sm" className="items-center">
          <span className="text-xs">
            {row.verdict === "wrong"
              ? "Feedback recorded"
              : row.verdict
                ? humanize(row.verdict)
                : "Not reviewed"}
          </span>
          <Button
            size="sm"
            variant="outline"
            disabled={review.isPending || row.verdict === "wrong"}
            onClick={() =>
              review.mutate({
                suggestionId: row.id,
                operationId: crypto.randomUUID(),
                verdict: "wrong",
                intent: "history",
                expectedFingerprint: row.fingerprint,
                correction: { present: false },
              })
            }
          >
            Report incorrect
          </Button>
        </Row>
      }
      detail={
        <Stack gap="sm">
          <section aria-label="Applied result">
            <p className="text-sm font-medium">Applied result</p>
            <p className="text-xs">{row.summary}</p>
            {row.automaticRule ? (
              <p className="text-xs text-muted-foreground">
                Automatic rule: {row.automaticRule}
              </p>
            ) : null}
          </section>
          <Disclosure summary="Evidence" className="text-xs">
            <pre className="break-words whitespace-pre-wrap">
              {JSON.stringify(row.decision, null, 2)}
            </pre>
          </Disclosure>
          {row.verdict === "wrong" ? (
            <Description size="xs">
              Feedback recorded for resuggestion where supported on the next
              suggestion run. Applied records stay as they are; open an affected
              record above if it needs editing. Automation remains unchanged.
            </Description>
          ) : null}
          {review.error ? (
            <ErrorDisplay
              error={review.error}
              title="automatic decision feedback"
            />
          ) : null}
        </Stack>
      }
    />
  );
}
