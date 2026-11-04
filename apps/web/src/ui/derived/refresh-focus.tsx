import { entityRoster } from "@cubby/schemas/entity-roster";
import type { FieldRefreshLocator } from "@cubby/schemas/field-explanation";
import { humanize } from "@cubby/shared";
import { useQuery } from "@tanstack/react-query";

import { useEntityMetadata } from "~/entity/metadata";
import { derived } from "~/integrations/tanstack-query/generated/domains/derived.gen";
import { fieldExplanation } from "~/integrations/tanstack-query/generated/domains/fieldExplanation.gen";
import { DateDisplay } from "~/ui/common/date-display";
import { RecordList, RecordRow } from "~/ui/common/record-list";
import { ErrorDisplay } from "~/ui/feedback/error-display";
import { QuerySection } from "~/ui/feedback/query-section";
import { useHydrated } from "~/ui/hooks/use-hydrated";
import { Section } from "~/ui/layout";
import { Button } from "~/ui/primitives/button";
import { StatusText } from "~/ui/primitives/status-text";

import { refreshStateSummary } from "./backlog";
import { DecisionResult, DerivedFreshness } from "./decision-chain";
import { ExplanationEntityLink } from "./why-value";

/** Read on open and on request: an idle Activity view must not poll the database. */
const ON_DEMAND_READ = {
  staleTime: 0,
  refetchOnMount: "always",
  refetchInterval: false,
} as const;

/** Clear stays outside the read boundary so a stale link can always be dismissed. */
export function DerivedRefreshFocus({
  locator,
  onClear,
}: {
  locator: FieldRefreshLocator;
  onClear: () => void;
}) {
  const hydrated = useHydrated();
  return (
    <Section
      headingAs="h2"
      title="Value refresh"
      actions={
        <Button
          variant="ghost"
          size="sm"
          disabled={!hydrated}
          onClick={onClear}
        >
          Clear
        </Button>
      }
    >
      <QuerySection
        title="this value's refresh status"
        resetKey={JSON.stringify(locator)}
        fallback={<StatusText>Reading refresh status…</StatusText>}
      >
        <RefreshFocusRow locator={locator} />
      </QuerySection>
    </Section>
  );
}

function RefreshFocusRow({ locator }: { locator: FieldRefreshLocator }) {
  const hydrated = useHydrated();
  const metadata = useEntityMetadata(locator.entityKind);
  const field = metadata.fields.fields.find(
    (candidate) => candidate.key === locator.field,
  );
  const label = field?.label ?? humanize(locator.field);
  // Never `diagnostic`: this observes the slot and must not recompute its value.
  const explanation = useQuery({
    ...fieldExplanation.explain.queryOptions(locator),
    ...ON_DEMAND_READ,
  });
  const backlog = useQuery({
    ...derived.backlog.queryOptions({}),
    ...ON_DEMAND_READ,
  });
  const refresh = () => {
    void explanation.refetch();
    void backlog.refetch();
  };
  const states = backlog.data?.kinds.find(
    (kind) =>
      kind.entity === locator.entityKind &&
      kind.field === (field?.storedKey ?? locator.field),
  )?.states;
  const observed = explanation.data;
  return (
    <RecordList>
      <RecordRow
        primary={
          <span className="min-w-0 break-words">
            <ExplanationEntityLink
              entity={locator.entityKind}
              id={locator.entityId}
            />{" "}
            · {label}
          </span>
        }
        actions={
          <Button
            variant="outline"
            size="sm"
            disabled={!hydrated || explanation.isFetching || backlog.isFetching}
            onClick={refresh}
          >
            Refresh status
          </Button>
        }
        detail={
          <div className="grid gap-2">
            {explanation.isPending ? (
              <StatusText>Reading refresh status…</StatusText>
            ) : null}
            {explanation.isError ? (
              <ErrorDisplay
                error={explanation.error}
                title="this value's refresh status"
                onRetry={refresh}
              />
            ) : null}
            {observed ? (
              <>
                {/* The work line below owns a missing value's status. */}
                {observed.envelope.result.kind === "missing" ? null : (
                  <DecisionResult
                    result={observed.envelope.result}
                    work={observed.envelope.work}
                    entity={observed.subject.entityKind}
                    field={observed.field}
                  />
                )}
                <DerivedFreshness
                  envelope={observed.envelope}
                  context={observed}
                />
                <p className="text-xs text-muted-foreground">
                  Value observed{" "}
                  <DateDisplay timestamp={observed.evaluatedAt} />
                </p>
              </>
            ) : null}
            {backlog.isError ? (
              <ErrorDisplay
                error={backlog.error}
                title="all work for this value"
                onRetry={refresh}
              />
            ) : null}
            {states ? (
              <p className="text-xs text-muted-foreground">
                All {entityRoster[locator.entityKind].singular} · {label} work,
                including related refreshes: {refreshStateSummary(states)} ·
                Observed <DateDisplay timestamp={backlog.dataUpdatedAt} />
              </p>
            ) : null}
          </div>
        }
      />
    </RecordList>
  );
}
