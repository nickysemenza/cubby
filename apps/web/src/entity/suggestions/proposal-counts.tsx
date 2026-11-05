import type { suggestionRecordCountsOut } from "@cubby/schemas/automatic-decision";
import type { Entity } from "@cubby/schemas/entity";
import { entityRoster } from "@cubby/schemas/entity-roster";
import { parseShortcode } from "@cubby/shared";
import { countLabel } from "@cubby/shared/pluralize";
import { useQueries, type UseQueryResult } from "@tanstack/react-query";
import { chunk } from "es-toolkit";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { z } from "zod";

import { publicationCoverageMessage } from "~/entity/suggestions/publication-coverage";
import { RecordProposals } from "~/entity/suggestions/queue/record-proposals";
import { suggestions } from "~/integrations/tanstack-query/generated/domains/suggestions.gen";
import { ErrorDisplay } from "~/ui/feedback/error-display";
import { Button } from "~/ui/primitives/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "~/ui/primitives/popover";

const identity = z.object({ id: z.string() });
const ActiveRecordsContext = createContext<((id: string) => () => void) | null>(
  null,
);
const Context = createContext<{
  counts: ReadonlyMap<string, number>;
  errors: ReadonlyMap<string, unknown>;
  retries: ReadonlyMap<string, () => void>;
  coverage: ReadonlyMap<
    string,
    z.infer<typeof suggestionRecordCountsOut>["coverage"]
  >;
} | null>(null);
const combine = (
  queries: UseQueryResult<z.infer<typeof suggestionRecordCountsOut>>[],
) => ({
  records: queries.flatMap((query) => query.data?.records ?? []),
  errors: queries.map((query) => query.error),
  retries: queries.map((query) => query.refetch),
  coverage: queries.map((query) => query.data?.coverage),
});

/** Stable roster batches retain counts; only the viewport and its buffer fetch. */
export function ProposalCountProvider({
  entity,
  records,
  viewportOnly = false,
  children,
}: {
  entity: Entity | undefined;
  records: readonly unknown[];
  viewportOnly?: boolean;
  children: ReactNode;
}) {
  const [activeRecordIds, setActiveRecordIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const activeCounts = useRef(new Map<string, number>());
  const activateRecord = useCallback((id: string) => {
    const counts = activeCounts.current;
    const count = counts.get(id) ?? 0;
    counts.set(id, count + 1);
    if (count === 0) setActiveRecordIds(new Set(counts.keys()));
    return () => {
      const remaining = (counts.get(id) ?? 1) - 1;
      if (remaining) counts.set(id, remaining);
      else {
        counts.delete(id);
        setActiveRecordIds(new Set(counts.keys()));
      }
    };
  }, []);
  const batches = useMemo(
    () =>
      chunk(
        records.flatMap((record) => {
          const row = identity.safeParse(record);
          const code = row.success ? parseShortcode(row.data.id) : null;
          return code && code.type === entity ? [code.shortcode] : [];
        }),
        50,
      ),
    [records, entity],
  );
  const result = useQueries({
    queries: batches.map((recordIds) => ({
      ...suggestions.recordCounts.queryOptions({ recordIds }),
      // Keep inactive observers' cached counts without refreshing the entire
      // loaded roster when a suggestion changes. Re-entry refetches stale data.
      enabled: !viewportOnly || recordIds.some((id) => activeRecordIds.has(id)),
    })),
    combine,
  });
  const context = useMemo(
    () => ({
      counts: new Map(result.records.map((row) => [row.id, row.pending])),
      coverage: new Map(
        result.coverage.flatMap((coverage, index) =>
          coverage
            ? (batches[index] ?? []).map((id) => [id, coverage] as const)
            : [],
        ),
      ),
      // Retain each batch's diagnostics with its records, just like its data.
      // An inactive failed batch must not label healthy visible rows as failed.
      errors: new Map(
        result.errors.flatMap((error, index) =>
          error ? (batches[index] ?? []).map((id) => [id, error] as const) : [],
        ),
      ),
      retries: new Map(
        result.errors.flatMap((error, index) => {
          const retry = result.retries[index];
          return error && retry
            ? (batches[index] ?? []).map(
                (id) => [id, () => void retry()] as const,
              )
            : [];
        }),
      ),
    }),
    [result.records, result.errors, result.retries, result.coverage, batches],
  );
  return (
    <ActiveRecordsContext value={viewportOnly ? activateRecord : null}>
      <Context value={context}>{children}</Context>
    </ActiveRecordsContext>
  );
}

export function ProposalCount({
  record,
  field,
  children,
}: {
  record: unknown;
  field?: string;
  children?: ReactNode;
}) {
  const row = identity.safeParse(record);
  const code = row.success ? parseShortcode(row.data.id) : null;
  if (
    !code ||
    (field !== undefined && field !== entityRoster[code.type].titleField)
  )
    return children;
  return (
    <EligibleProposalCount recordId={code.shortcode}>
      {children}
    </EligibleProposalCount>
  );
}

function EligibleProposalCount({
  recordId,
  children,
}: {
  recordId: NonNullable<ReturnType<typeof parseShortcode>>["shortcode"];
  children: ReactNode;
}) {
  const activate = useContext(ActiveRecordsContext);
  useEffect(() => activate?.(recordId), [activate, recordId]);
  const context = useContext(Context);
  const error = context?.errors.get(recordId);
  const [open, setOpen] = useState(false);
  const count = context?.counts.get(recordId) ?? 0;
  const coverage = context?.coverage.get(recordId);
  const status = error
    ? "Couldn't refresh suggestion counts. Showing known results."
    : publicationCoverageMessage(coverage);
  return (
    <span className="inline-flex min-w-0 items-center gap-1">
      <span className="min-w-0">{children}</span>
      {error ? (
        <ErrorDisplay
          error={error}
          title="pending suggestions"
          onRetry={context?.retries.get(recordId)}
        />
      ) : null}
      {count > 0 || status ? (
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger
            render={
              <Button
                size="xs"
                variant="outline"
                className="relative z-[1] shrink-0 tabular-nums"
                aria-label={
                  status
                    ? `${countLabel(count, "known pending suggestion")}. ${status}`
                    : countLabel(count, "pending suggestion")
                }
                onClick={(event) => event.stopPropagation()}
              />
            }
          >
            {status ? (count > 0 ? `${count}+` : "?") : count}
          </PopoverTrigger>
          <PopoverContent
            className="max-h-[70vh] w-[min(56rem,calc(100vw-2rem))] overflow-y-auto"
            onClick={(event) => event.stopPropagation()}
          >
            {status ? (
              <p className="mb-2 text-sm text-muted-foreground">{status}</p>
            ) : null}
            {open ? <RecordProposals id={recordId} /> : null}
          </PopoverContent>
        </Popover>
      ) : null}
    </span>
  );
}
