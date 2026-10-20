import { assessmentFamily } from "@cubby/schemas/assessment";
import { assessmentReviewFamilies } from "@cubby/schemas/assessment-review-family";
import type { AutomaticDecisionRow } from "@cubby/schemas/automatic-decision";
import { humanize } from "@cubby/shared";
import { CaretRightIcon } from "@phosphor-icons/react/dist/csr/CaretRight";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { usePageCount } from "~/entity/page/page";
import { ripple } from "~/integrations/tanstack-query/cache-tags";
import {
  assessment,
  suggestions,
} from "~/integrations/tanstack-query/generated/catalog.gen";
import { invalidateOperationTags } from "~/integrations/tanstack-query/operation-cache";
import { Picker } from "~/ui/combobox/picker";
import { DateDisplay } from "~/ui/common/date-display";
import { RecordList, RecordRow } from "~/ui/common/record-list";
import { ErrorDisplay } from "~/ui/feedback/error-display";
import { useHydratedLoading } from "~/ui/hooks/use-hydrated";
import { Stack, Row } from "~/ui/layout";
import { Button } from "~/ui/primitives/button";

import { ScopedListPager } from "./scoped-list-pager";
import { RecordLink } from "./suggestion-values";

const FAMILY_OPTIONS = [
  { value: "all", label: "All families" },
  ...assessmentFamily.options.map((family) => ({
    value: family,
    label: assessmentReviewFamilies[family].label,
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
      family: assessmentFamily.safeParse(family).data,
      recordIds: id ? [id] : undefined,
      reviewStatus,
      offset,
      limit: 50,
    }),
  );
  const loading = useHydratedLoading(query.isLoading);
  usePageCount(id || query.isLoading ? undefined : query.data?.totalCount);
  return (
    <section aria-label="Automatic decisions">
      <Stack gap="sm">
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
            title="automatic decisions"
            onRetry={() => void query.refetch()}
          />
        ) : null}
        <RecordList
          state={loading ? { status: "pending" } : { status: "success" }}
          empty="No automatic decisions in this scope."
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

function AutomaticDecision({ row }: { row: AutomaticDecisionRow }) {
  const [correcting, setCorrecting] = useState(false);
  const [choice, setChoice] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const review = useMutation(
    assessment.review.mutationOptions({
      onSuccess: async () => {
        setCorrecting(false);
        await invalidateOperationTags(queryClient, ripple.suggestions);
      },
    }),
  );
  const options =
    row.correction?.options.map((option, index) => ({
      label: option.label,
      value: String(index),
    })) ?? [];
  const wrong = (
    correction?: NonNullable<
      AutomaticDecisionRow["correction"]
    >["options"][number],
  ) =>
    review.mutate({
      assessmentId: row.id,
      operationId: crypto.randomUUID(),
      verdict: "wrong",
      intent: correction ? "apply" : "history",
      expectedFingerprint: row.fingerprint,
      correction: correction
        ? { present: true, value: correction.value }
        : { present: false },
    });
  return (
    <RecordRow
      primary={
        <Row gap="sm" className="flex-wrap">
          <span>{assessmentReviewFamilies[row.family].label}</span>
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
            {row.verdict ? humanize(row.verdict) : "Unreviewed"}
          </span>
          <Button
            size="sm"
            variant="outline"
            disabled={review.isPending || row.verdict === "wrong"}
            onClick={() => (row.correction ? setCorrecting(true) : wrong())}
          >
            Wrong
          </Button>
        </Row>
      }
      detail={
        <Stack gap="sm">
          {row.automaticRule ? (
            <span className="text-xs text-muted-foreground">
              Rule {row.automaticRule}
            </span>
          ) : null}
          <details className="group text-xs">
            <summary className="flex min-h-11 cursor-pointer list-none items-center gap-1 text-muted-foreground md:min-h-7 [&::-webkit-details-marker]:hidden">
              <CaretRightIcon
                aria-hidden
                className="size-3.5 group-open:rotate-90"
              />
              Technical evidence
            </summary>
            <pre className="break-words whitespace-pre-wrap">
              {JSON.stringify(row.decision, null, 2)}
            </pre>
          </details>
          {correcting && row.correction ? (
            <Row gap="sm" className="flex-wrap">
              <Picker
                mode="choose"
                aria-label={row.correction.label}
                options={options}
                value={choice}
                onValueChange={setChoice}
              />
              <Button
                size="sm"
                disabled={review.isPending || choice === null}
                onClick={() => {
                  const correction = row.correction?.options[Number(choice)];
                  if (correction) wrong(correction);
                }}
              >
                Save correction
              </Button>
              <Button size="sm" variant="ghost" onClick={() => wrong()}>
                Record Wrong only
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setCorrecting(false)}
              >
                Cancel
              </Button>
            </Row>
          ) : null}
          {row.verdict === "wrong" && row.correction === null ? (
            <p className="text-xs text-muted-foreground">
              Feedback recorded. Open an affected record above to correct it
              through its existing actions.
            </p>
          ) : null}
          {review.error ? (
            <ErrorDisplay
              error={review.error}
              title="automatic decision review"
            />
          ) : null}
        </Stack>
      }
    />
  );
}
