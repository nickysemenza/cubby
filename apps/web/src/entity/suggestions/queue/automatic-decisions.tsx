import { automaticDecisionFamily } from "@cubby/schemas/automatic-decision";
import type { AutomaticDecisionRow } from "@cubby/schemas/automatic-decision";
import { suggestionReviewFamilies } from "@cubby/schemas/suggestion-review-family";
import { humanize } from "@cubby/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Fragment, useState } from "react";

import { usePageCount } from "~/entity/page/page";
import { ripple } from "~/integrations/tanstack-query/cache-tags";
import { suggestion as suggestionApi } from "~/integrations/tanstack-query/generated/domains/suggestion.gen";
import { suggestions } from "~/integrations/tanstack-query/generated/domains/suggestions.gen";
import { invalidateOperationTags } from "~/integrations/tanstack-query/operation-cache";
import { formatCalendarDay } from "~/lib/date-format";
import { householdLocalDate, shiftPlainDate } from "~/lib/household-date";
import { Picker } from "~/ui/combobox/picker";
import { ErrorDisplay } from "~/ui/feedback/error-display";
import { useDisplayNow } from "~/ui/hooks/use-display-now";
import { useHydratedLoading } from "~/ui/hooks/use-hydrated";
import { Stack, Row } from "~/ui/layout";
import { Disclosure } from "~/ui/layout";
import { Button } from "~/ui/primitives/button";
import {
  RecordHeading,
  RecordList,
  RecordRow,
  type RecordColumn,
} from "~/ui/records/record-list";
import { Description } from "~/ui/text/description";
import { DateDisplay } from "~/ui/values/date-display";

import { useRenderedText } from "../use-rendered-text";
import { ScopedListPager } from "./scoped-list-pager";
import { FieldSummary, FieldValue, RecordLink } from "./suggestion-values";

const FAMILY_OPTIONS = [
  { value: "all", label: "All changes" },
  ...automaticDecisionFamily.options.map((family) => ({
    value: family,
    label: suggestionReviewFamilies[family].label,
  })),
];

const COLUMNS: readonly RecordColumn[] = [
  { id: "field", label: "Field" },
  { id: "change", label: "Change" },
  { id: "confidence", label: "Sure" },
];

/** "Today", "Yesterday" or the household calendar day of a change. */
function dayLabel(day: string, today: string) {
  if (day === today) return "Today";
  if (day === shiftPlainDate(today, -1)) return "Yesterday";
  return formatCalendarDay(
    day,
    day.slice(0, 4) === today.slice(0, 4) ? "weekdayMonthDay" : "dateShort",
  );
}

type Cause = NonNullable<AutomaticDecisionRow["cause"]>;

/** What one group of Cubby's changes says it did; the count follows it. */
const CAUSE_LABEL = {
  new_record: "New records",
  import: "Import",
  evidence_changed: "After records changed",
  correction: "Because you corrected a similar value",
  policy_revision: "Model update",
  released: "You let Cubby decide",
} satisfies Record<Cause["kind"], string>;

/**
 * Consecutive rows that share a cause (and its Run or revision), or a
 * household day for rows recorded before causes were; a page boundary may
 * repeat a header.
 */
function byCause(rows: readonly AutomaticDecisionRow[], today: string) {
  const groups: { key: string; label: string; rows: AutomaticDecisionRow[] }[] =
    [];
  for (const row of rows) {
    const day = householdLocalDate(new Date(row.createdAt));
    const key = row.cause
      ? `${row.cause.kind}:${row.cause.ref ?? day}`
      : `day:${day}`;
    const label = row.cause
      ? `${CAUSE_LABEL[row.cause.kind]}, ${dayLabel(day, today)}`
      : dayLabel(day, today);
    const last = groups.at(-1);
    if (last?.key === key) last.rows.push(row);
    else groups.push({ key, label, rows: [row] });
  }
  return groups;
}

/**
 * Changes by Cubby: values Cubby set on its own, newest first, grouped by
 * why Cubby asked (a new record, an import, a correction, a model update). Each field change offers Keep and "Wrong, clear it"; mail and
 * statement decisions keep their own row content and feedback.
 */
export function AutomaticDecisions({
  id,
  initialFamily = "all",
}: {
  id?: string;
  initialFamily?: string;
}) {
  const [family, setFamily] = useState(initialFamily);
  const [offset, setOffset] = useState(0);
  const now = useDisplayNow() ?? Date.now();
  const today = householdLocalDate(new Date(now));
  const query = useQuery(
    suggestions.automaticDecisions.queryOptions({
      family: automaticDecisionFamily.safeParse(family).data,
      recordIds: id ? [id] : undefined,
      reviewStatus: "all",
      offset,
      limit: 50,
    }),
  );
  const loading = useHydratedLoading(query.isLoading);
  usePageCount(id || query.isLoading ? undefined : query.data?.totalCount);
  return (
    <section aria-label="Changes by Cubby">
      <Stack gap="sm">
        <Row gap="sm" className="flex-wrap">
          <Picker
            mode="choose"
            compact
            className="w-full md:w-60"
            aria-label="Change kind"
            options={FAMILY_OPTIONS}
            value={family}
            onValueChange={(value) => {
              setFamily(value ?? "all");
              setOffset(0);
            }}
          />
        </Row>
        {query.error ? (
          <ErrorDisplay
            error={query.error}
            title="changes by Cubby"
            onRetry={() => void query.refetch()}
          />
        ) : null}
        <RecordList
          columns={COLUMNS}
          state={loading ? { status: "pending" } : { status: "success" }}
          empty="Cubby hasn't changed anything yet. Values it fills in on its own are listed here."
        >
          {byCause(query.data?.items ?? [], today).map((group) => (
            <Fragment key={`${group.key}:${group.rows[0]?.id}`}>
              <RecordHeading label={group.label} count={group.rows.length} />
              {group.rows.map((row) =>
                row.field ? (
                  <FieldChange key={row.id} row={row} change={row.field} />
                ) : (
                  <AutomaticDecision key={row.id} row={row} />
                ),
              )}
            </Fragment>
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

type FieldChangeEvidence = NonNullable<AutomaticDecisionRow["field"]>;
type AuthorityAction = "keep" | "clear";
const RESULT = {
  keep: "Kept.",
  clear: "Cleared. Cubby will try again.",
} satisfies Record<AuthorityAction, string>;

/** One value Cubby set: record, field, old → new, how sure, when. */
function FieldChange({
  row,
  change,
}: {
  row: AutomaticDecisionRow;
  change: FieldChangeEvidence;
}) {
  const [done, setDone] = useState<AuthorityAction | null>(null);
  const authority = useMutation(
    suggestionApi.fieldAuthority.mutationOptions({
      onSuccess: (_, input) => {
        if (input.action === "keep" || input.action === "clear")
          setDone(input.action);
      },
    }),
  );
  const recordText = useRenderedText();
  const valueText = useRenderedText();
  const record = { entity: change.entity, id: change.recordId };
  const run = (action: AuthorityAction) =>
    authority.mutate({
      entity: change.entity,
      id: change.recordId,
      field: change.field,
      action,
      // The row's own value: refused once Cubby has revised it since.
      suggestionId: change.suggestionId,
    });
  // Only a value Cubby still holds and nobody has answered offers actions.
  const current = change.status === "applied" && row.verdict === null;
  const object = [valueText.text, recordText.text && `for ${recordText.text}`]
    .filter(Boolean)
    .join(" ");
  return (
    <RecordRow
      primary={
        <span ref={recordText.ref} className="inline-flex min-w-0">
          <RecordLink record={record} />
        </span>
      }
      facts={[
        {
          id: "field",
          label: "Field",
          value: <FieldSummary entity={change.entity} field={change.field} />,
        },
        {
          id: "change",
          label: "Change",
          value: (
            <span className="inline-flex min-w-0 items-center gap-1">
              <span className="sr-only">Changed from </span>
              <FieldValue
                entity={change.entity}
                recordId={change.recordId}
                field={change.field}
                value={change.currentValue}
              />
              {/* The arrow stays attached to its destination value. */}
              <span className="inline-flex min-w-0 items-center gap-1 whitespace-nowrap">
                <span aria-hidden className="text-muted-foreground">
                  →
                </span>
                <span className="sr-only"> to </span>
                <span ref={valueText.ref} className="inline-flex min-w-0">
                  <FieldValue
                    entity={change.entity}
                    recordId={change.recordId}
                    field={change.field}
                    value={change.suggestedValue}
                  />
                </span>
              </span>
            </span>
          ),
        },
        {
          id: "confidence",
          label: "Sure",
          value: (
            <span className="font-mono text-xs text-muted-foreground tabular-nums">
              {Math.round(change.confidence * 100)}%
            </span>
          ),
        },
      ]}
      trailing={<DateDisplay timestamp={row.createdAt} />}
      actions={
        <span className="inline-flex items-center gap-1">
          {done || !current ? null : (
            <>
              <Button
                size="xs"
                variant="ghost"
                disabled={authority.isPending}
                aria-label={object ? `Keep ${object}` : undefined}
                onClick={() => run("keep")}
              >
                Keep
              </Button>
              <Button
                size="xs"
                variant="ghost"
                disabled={authority.isPending}
                aria-label={object ? `Wrong, clear it: ${object}` : undefined}
                onClick={() => run("clear")}
              >
                Wrong, clear it
              </Button>
            </>
          )}
          {/* Rendered before it changes so assistive tech announces the result. */}
          <output className="text-xs text-muted-foreground">
            {done ? RESULT[done] : null}
          </output>
        </span>
      }
      detail={
        authority.error ? (
          <ErrorDisplay error={authority.error} title="this change" />
        ) : undefined
      }
    />
  );
}

/** A mail or statement decision: its summary, evidence and history feedback. */
function AutomaticDecision({ row }: { row: AutomaticDecisionRow }) {
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
                expectedFingerprint: row.fingerprint ?? undefined,
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
          <Disclosure summary="Evidence" className="text-xs">
            <pre className="break-words whitespace-pre-wrap">
              {JSON.stringify(row.decision, null, 2)}
            </pre>
          </Disclosure>
          {row.verdict === "wrong" ? (
            <Description size="xs">
              Feedback recorded. Applied records stay as they are; open an
              affected record above if it needs editing.
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
