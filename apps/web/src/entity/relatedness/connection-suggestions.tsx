import { isEntityPairAssessmentFamily } from "@cubby/schemas/assessment";
import type { Entity, EntityRef } from "@cubby/schemas/entity";
import type { ConnectionProposal } from "@cubby/schemas/entity-connections";
import { entitySummary } from "@cubby/schemas/entity-summary";
import {
  parseShortcodeFor,
  type RunShortcode,
} from "@cubby/schemas/identifiers";
import { parseShortcode } from "@cubby/shared";
import { LinkIcon } from "@phosphor-icons/react/dist/csr/Link";
import {
  useQueries,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from "@tanstack/react-query";
import { Link, useRouter } from "@tanstack/react-router";
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  type ReactNode,
} from "react";
import { z } from "zod";

import { EntityRefLink } from "~/entity/components/entity-ref-link";
import {
  entities,
  entityDetailParams,
  isBrowserRoutedEntity,
} from "~/entity/entities";
import { useActionMutation } from "~/entity/hooks/use-action-mutation";
import { ripple } from "~/integrations/tanstack-query/cache-tags";
import {
  assessment,
  connection,
  run,
} from "~/integrations/tanstack-query/generated/catalog.gen";
import { invalidateOperationTags } from "~/integrations/tanstack-query/operation-cache";
import { ErrorDisplay } from "~/ui/feedback/error-display";
import { Row, Stack } from "~/ui/layout";
import { Badge } from "~/ui/primitives/badge";
import { Button } from "~/ui/primitives/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "~/ui/primitives/popover";

const identity = z.object({ id: z.string() });
type StoredDocument = { source: EntityRef; proposals: ConnectionProposal[] };
const ConnectionContext = createContext<{
  rows: ReadonlyMap<string, readonly ConnectionProposal[]>;
  error: unknown;
} | null>(null);
const EMPTY_PROPOSALS: readonly ConnectionProposal[] = [];
/** Detail-page section that hosts `ConnectionSuggestions`. */
const RELATIONSHIPS_SECTION = "relationships";
const combineBatches = (queries: UseQueryResult<StoredDocument[]>[]) => ({
  documents: queries.flatMap((query) => query.data ?? []),
  error: queries.find((query) => query.error)?.error ?? null,
});

/** Batch stored reads for list rows; mounting a table never starts discovery. */
export function ConnectionSuggestionsProvider({
  entity,
  records,
  children,
}: {
  entity: Entity | undefined;
  records: readonly unknown[];
  children: ReactNode;
}) {
  const batches = useMemo(() => {
    const sources: EntityRef[] = [];
    for (const record of records) {
      const row = identity.safeParse(record);
      const code = row.success ? parseShortcode(row.data.id) : null;
      if (code && code.type === entity)
        sources.push({ entityKind: code.type, entityId: code.shortcode });
    }
    const result: EntityRef[][] = [];
    for (let offset = 0; offset < sources.length; offset += 250)
      result.push(sources.slice(offset, offset + 250));
    return result;
  }, [entity, records]);
  const result = useQueries({
    queries: batches.map((sources) =>
      connection.readBatch.queryOptions({ sources }),
    ),
    combine: combineBatches,
  });
  const value = useMemo(
    () => ({
      rows: new Map(
        result.documents.map((document) => [
          document.source.entityId,
          document.proposals,
        ]),
      ),
      error: result.error,
    }),
    [result.documents, result.error],
  );
  return <ConnectionContext value={value}>{children}</ConnectionContext>;
}

function ConnectionReviewRows({
  proposals,
  source,
}: {
  proposals: readonly ConnectionProposal[];
  source?: EntityRef;
}) {
  const router = useRouter();
  const review = useActionMutation({
    mutationFn: assessment.review.mutationOptions,
    onSuccess: async (result) => {
      const applied = result.applicationResult;
      if (
        source &&
        applied &&
        source.entityKind === applied.source.entityKind &&
        source.entityId === applied.source.entityId &&
        source.entityId !== applied.destination.entityId &&
        isBrowserRoutedEntity(applied.destination.entityKind)
      )
        await router.navigate({
          to: entities[applied.destination.entityKind].routes.detail,
          params: entityDetailParams(applied.destination.entityId),
        });
    },
  });
  const settle = (
    proposal: ConnectionProposal,
    verdict: "correct" | "wrong" | "uncertain" | "dismissed",
    persistent = false,
  ) =>
    review.mutate({
      assessmentId: proposal.review.assessmentId,
      operationId: crypto.randomUUID(),
      verdict,
      intent: verdict === "correct" ? "apply" : "history",
      expectedFingerprint: proposal.fingerprint,
      ...(persistent && proposal.review.suppression
        ? { suppression: proposal.review.suppression }
        : {}),
    });
  return (
    <Stack gap="sm">
      {proposals.map((proposal) => (
        <Stack
          key={proposal.review.assessmentId}
          gap="xs"
          className="border-b pb-2 last:border-b-0"
        >
          <span className="text-sm font-medium">{proposal.label}</span>
          <Row gap="xs" align="center" className="flex-wrap text-sm">
            <EntityRefLink
              variant="audit"
              entityKind={proposal.source.entityKind}
              entityId={proposal.source.entityId}
              name={proposal.sourceName}
              displayImage={null}
            />
            <span aria-hidden="true">→</span>
            <EntityRefLink
              variant="audit"
              entityKind={proposal.target.entityKind}
              entityId={proposal.target.entityId}
              name={proposal.targetName}
              displayImage={null}
            />
          </Row>
          {proposal.evidence.reasons.map((reason) => (
            <p key={reason} className="text-xs text-muted-foreground">
              {reason}
            </p>
          ))}
          {proposal.evidence.contradictions.map((reason) => (
            <p key={reason} className="text-xs">
              Conflict: {reason}
            </p>
          ))}
          {proposal.evidence.unknowns.map((reason) => (
            <p key={reason} className="text-xs text-muted-foreground">
              Unknown: {reason}
            </p>
          ))}
          {proposal.integration.kind === "product-pair-review" ? (
            <Button
              size="sm"
              variant="outline"
              render={
                <Link
                  to="/recommendations/workbench"
                  search={{
                    kind: "product-match",
                    source: parseShortcodeFor(
                      "product",
                      proposal.source.entityId,
                    ),
                    candidate: parseShortcodeFor(
                      "product",
                      proposal.target.entityId,
                    ),
                  }}
                />
              }
            >
              Review Product identity
            </Button>
          ) : (
            <Row gap="xs" className="flex-wrap">
              <Button
                size="sm"
                disabled={
                  review.isPending ||
                  proposal.evidence.contradictions.length > 0
                }
                onClick={() => settle(proposal, "correct")}
              >
                Confirm connection
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={review.isPending}
                onClick={() => settle(proposal, "wrong")}
              >
                Wrong connection
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={review.isPending}
                onClick={() => settle(proposal, "uncertain")}
              >
                Uncertain
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={review.isPending}
                onClick={() => settle(proposal, "dismissed")}
              >
                Dismiss
              </Button>
              {proposal.review.suppression && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={review.isPending}
                  onClick={() => settle(proposal, "dismissed", true)}
                >
                  Never suggest this connection
                </Button>
              )}
            </Row>
          )}
        </Stack>
      ))}
      {review.error && (
        <ErrorDisplay error={review.error} title="connection review" />
      )}
    </Stack>
  );
}

function ConnectionDiscoveryProgress({ runId }: { runId: RunShortcode }) {
  const queryClient = useQueryClient();
  const status = useQuery({
    ...run.workSnapshot.queryOptions({ runId }),
    refetchInterval: (query) =>
      query.state.data?.status === "running" ? 3000 : false,
  });
  const current = status.data?.status;
  useEffect(() => {
    if (current && current !== "running")
      void invalidateOperationTags(queryClient, ripple.connections);
  }, [current, queryClient]);
  return (
    <Stack gap="xs">
      <p className="text-sm text-muted-foreground">
        Connection discovery: {current ?? "loading"}.{" "}
        <Link to="/runs/$shortcode" params={{ shortcode: runId }}>
          Open Run
        </Link>
      </p>
      {status.error && (
        <ErrorDisplay error={status.error} title="connection discovery Run" />
      )}
      {(status.error ||
        (current && current !== "running" && current !== "completed")) && (
        <Button
          size="sm"
          variant="outline"
          onClick={() => void status.refetch()}
        >
          Refresh discovery status
        </Button>
      )}
    </Stack>
  );
}

export function ConnectionSuggestions({ source }: { source: EntityRef }) {
  const query = useQuery(connection.read.queryOptions(source));
  const discover = useActionMutation({
    mutationFn: connection.discover.mutationOptions,
  });
  return (
    <Stack gap="sm">
      <Row justify="between" align="center" gap="sm">
        <span className="text-sm font-medium">Suggested connections</span>
        <Button
          size="sm"
          variant="outline"
          disabled={discover.isPending}
          onClick={() => discover.mutate(source)}
        >
          Find connections
        </Button>
      </Row>
      {query.isPending && (
        <output className="text-sm text-muted-foreground">
          Loading stored connections…
        </output>
      )}
      {query.error && <ErrorDisplay error={query.error} title="connections" />}
      {query.data && (
        <ConnectionReviewRows
          proposals={query.data.proposals}
          source={source}
        />
      )}
      {query.data?.proposals.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No pending connections. Find connections to check current evidence.
        </p>
      )}
      {discover.error && (
        <ErrorDisplay error={discover.error} title="connection discovery" />
      )}
      {discover.data?.discoveryRunId && (
        <ConnectionDiscoveryProgress runId={discover.data.discoveryRunId} />
      )}
    </Stack>
  );
}

/** Uses the same compact popover affordance as field suggestions. */
export function ConnectionCell({
  record,
  field,
  children,
}: {
  record: unknown;
  field: string;
  children: ReactNode;
}) {
  const context = useContext(ConnectionContext);
  const row = identity.safeParse(record);
  const code = row.success ? parseShortcode(row.data.id) : null;
  const titleField = code ? entitySummary[code.type].titleField : null;
  const proposals = row.success
    ? (context?.rows.get(row.data.id) ?? EMPTY_PROPOSALS)
    : EMPTY_PROPOSALS;
  const onTitle = field === titleField;
  // Entity-pair Assessments are possible duplicates of this record: a badge
  // opens the record's Suggestions panel instead of the row popover.
  const pairs = onTitle
    ? proposals.filter((proposal) =>
        isEntityPairAssessmentFamily(proposal.review.family),
      )
    : EMPTY_PROPOSALS;
  const visible = proposals.filter(
    (proposal) =>
      !isEntityPairAssessmentFamily(proposal.review.family) &&
      (proposal.integration.kind === "field-review" &&
      proposal.source.entityId === code?.shortcode
        ? proposal.integration.field === field
        : onTitle),
  );
  if (context?.error && onTitle)
    return (
      <Stack gap="xs">
        {children}
        <ErrorDisplay error={context.error} title="connection suggestions" />
      </Stack>
    );
  if (visible.length === 0 && pairs.length === 0) return children;
  return (
    <Row gap="xs" align="center" className="min-w-0">
      <span className="min-w-0">{children}</span>
      {code && pairs.length > 0 && isBrowserRoutedEntity(code.type) && (
        <Badge
          variant="warning"
          render={
            <Link
              to={entities[code.type].routes.detail}
              params={entityDetailParams(code.shortcode)}
              hash={RELATIONSHIPS_SECTION}
              onClick={(event) => event.stopPropagation()}
            />
          }
        >
          {pairs.length === 1
            ? "Possible match"
            : `${pairs.length} possible matches`}
        </Badge>
      )}
      {visible.length > 0 && (
        <Popover>
          <PopoverTrigger
            render={
              <Button
                size="icon"
                variant="ghost"
                aria-label="Review connections"
                onClick={(event) => event.stopPropagation()}
              />
            }
          >
            <LinkIcon className="size-3.5" aria-hidden="true" />
          </PopoverTrigger>
          <PopoverContent
            className="max-h-[70dvh] w-96 max-w-[calc(100vw-2rem)] overflow-y-auto"
            onClick={(event) => event.stopPropagation()}
          >
            <ConnectionReviewRows proposals={visible} />
          </PopoverContent>
        </Popover>
      )}
    </Row>
  );
}
