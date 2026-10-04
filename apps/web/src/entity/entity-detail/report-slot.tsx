import { slotActionsOf } from "@cubby/schemas/entity-report";
import type {
  EntityReportInput,
  ReportBlock,
} from "@cubby/schemas/entity-report";
import {
  type QueryClient,
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { type ReactNode, useEffect } from "react";
import { z } from "zod";

import { ripple } from "~/integrations/tanstack-query/cache-tags";
import { entityReport } from "~/integrations/tanstack-query/generated/catalog.gen";
import { invalidateOperationTags } from "~/integrations/tanstack-query/operation-cache";
import { cn, formatCurrency } from "~/lib/utils";
import { useSectionVisible } from "~/ui/data-table/detail-page";
import { ErrorDisplay } from "~/ui/feedback/error-display";
import { Row, Stack } from "~/ui/layout";
import { Button } from "~/ui/primitives/button";
import { Description } from "~/ui/primitives/description";
import { Eyebrow } from "~/ui/primitives/eyebrow";
import { Skeleton } from "~/ui/primitives/skeleton";
import { ShortcodeProse } from "~/ui/shortcode-prose";

import { RecordsBlockView, ReportVerb } from "./records-block";

const TONE_TEXT = {
  positive: "text-positive",
  warning: "text-warning-ink",
  destructive: "text-destructive",
  muted: "text-muted-foreground",
} as const;
const TONE_FILL = {
  positive: "bg-positive",
  warning: "bg-warning",
  destructive: "bg-destructive",
  muted: "bg-muted-foreground",
} as const;

const formatValue = (value: number, format: "money" | "count" | "text") =>
  format === "money" ? formatCurrency(value, 0) : String(value);

function Stats({ block }: { block: Extract<ReportBlock, { kind: "stats" }> }) {
  return (
    <Row wrap gap="md" className="justify-between">
      {block.figures.map((figure) => (
        <Stack key={figure.label} gap="tight">
          <span className="my-0 eyebrow">{figure.label}</span>
          <span
            className={cn(
              "font-mono text-sm tabular-nums",
              figure.tone && TONE_TEXT[figure.tone],
            )}
          >
            {figure.format === "text"
              ? (figure.text ?? "—")
              : figure.value == null
                ? "—"
                : formatValue(figure.value, figure.format)}
          </span>
        </Stack>
      ))}
    </Row>
  );
}

/** `stack` is one segmented bar against `marker`; every other mark is a ranked bar list. */
function Chart({ block }: { block: Extract<ReportBlock, { kind: "chart" }> }) {
  if (block.mark === "stack") {
    const gross = block.series.reduce((sum, entry) => sum + entry.value, 0);
    // Scale to whichever is larger so the marker stays on-bar when spend overruns it.
    const scaleMax = Math.max(block.marker ?? 0, gross) || 1;
    const markerPct =
      block.marker != null && block.marker < scaleMax
        ? (block.marker / scaleMax) * 100
        : null;
    return (
      <figure
        className="relative h-3 w-full overflow-hidden bg-muted"
        aria-label={block.caption}
      >
        {block.caption && (
          <figcaption className="sr-only">{block.caption}</figcaption>
        )}
        <div className="flex h-full w-full">
          {block.series.map((entry) => (
            <div
              key={entry.label}
              className={cn(
                "h-full transition-all",
                TONE_FILL[entry.tone ?? "positive"],
              )}
              style={{ width: `${(entry.value / scaleMax) * 100}%` }}
            />
          ))}
        </div>
        {markerPct != null && (
          <div
            className="absolute top-0 h-full w-px bg-foreground/40"
            style={{ left: `${markerPct}%` }}
          />
        )}
      </figure>
    );
  }
  const max = Math.max(
    ...block.series.map((entry) => Math.abs(entry.value)),
    1,
  );
  return (
    <Stack as="ul" gap="xs">
      {block.series.map((entry) => (
        <li key={entry.label} className="text-xs">
          <Row align="center" justify="between">
            <span className="truncate pr-2">{entry.label}</span>
            <span className="font-mono tabular-nums">
              {formatValue(entry.value, block.format)}
            </span>
          </Row>
          <div
            className="h-1 bg-primary/60"
            style={{ width: `${(Math.abs(entry.value) / max) * 100}%` }}
          />
        </li>
      ))}
    </Stack>
  );
}

function Table({ block }: { block: Extract<ReportBlock, { kind: "table" }> }) {
  if (block.rows.length === 0)
    return block.empty ? (
      <Description size="xs">{block.empty}</Description>
    ) : null;
  return (
    <Stack as="ul" gap="xs">
      {block.rows.map((row) => (
        <Row
          as="li"
          key={row.id}
          align="center"
          justify="between"
          className="text-xs"
        >
          <span className="truncate pr-2">{row.cells[0]}</span>
          <span className="font-mono tabular-nums">
            {row.cells.slice(1).join(" · ")}
          </span>
        </Row>
      ))}
    </Stack>
  );
}

/** Blocks have no id; a kind plus its title or text names each one within a report. */
const blockKey = (block: ReportBlock, index: number) =>
  block.kind === "records" && block.form
    ? // A form keeps its answers while other batches appear or the block's title changes.
      `form:${block.form.command.id}`
    : `${index}:${block.kind}:${block.kind === "note" ? block.text : block.kind === "schedule" ? "" : (block.title ?? "")}`;

/**
 * Draws the generic report blocks a detail slot's server read returns. A slot
 * with a richer web-only surface (the schedule grid) reads the same blocks
 * itself instead.
 */
function ReportBlocks({
  blocks,
  record,
  entity,
  recordsList,
}: {
  blocks: readonly ReportBlock[];
  record?: object;
  /** The record's entity, for the finance verbs a `records` block offers. */
  entity?: string;
  /** A richer web list for a `records` block (an editable table); the verbs stay generic. */
  recordsList?: (block: Extract<ReportBlock, { kind: "records" }>) => ReactNode;
}) {
  return (
    <Stack gap="xs">
      {blocks.map((block, index) => {
        const key = blockKey(block, index);
        switch (block.kind) {
          case "stats":
            return <Stats key={key} block={block} />;
          case "chart":
            return <Chart key={key} block={block} />;
          case "table":
            return (
              <div
                key={key}
                className={cn(
                  block.title && "mt-2 border-t border-border pt-2",
                )}
              >
                {block.title && (
                  <Eyebrow className="mb-1">{block.title}</Eyebrow>
                )}
                <Table block={block} />
              </div>
            );
          case "note":
            return (
              <Description
                key={key}
                size={block.strong ? "sm" : "xs"}
                className={cn(
                  block.strong && "font-medium text-foreground",
                  block.tone && TONE_TEXT[block.tone],
                )}
              >
                <ShortcodeProse>{block.text}</ShortcodeProse>
              </Description>
            );
          case "records":
            return (
              <RecordsBlockView
                key={key}
                block={block}
                record={record}
                entity={entity}
                list={recordsList?.(block)}
              />
            );
          case "schedule":
            return null;
        }
      })}
    </Stack>
  );
}

/** A record being worked refreshes its reports this often while the server says it is live. */
const LIVE_POLL_MS = 3_000;

/**
 * The Run slots one page polls together: a single `getMany` read loads the run once for all of
 * them. The paged and large ones (usage, log) read on their own and do not poll.
 */
const RUN_BATCH_SLOTS = [
  "run.live-progress",
  "run.import-stats",
  "run.import-progress-live",
  "run.import-progress-stopped",
  "run.import-purchases",
  "run.import-approvals",
  "run.import-findings",
  "run.import-targets",
  "run.import-evidence",
  "run.import-prepared-orders",
  "run.import-timeline",
] as const satisfies readonly EntityReportInput["slot"][];
const isBatchSlot = (slot: EntityReportInput["slot"]) =>
  RUN_BATCH_SLOTS.some((candidate) => candidate === slot);

type Records = Extract<ReportBlock, { kind: "records" }>;

/**
 * Pages after the first stack their rows under the first page's same-titled `records` block;
 * every other block comes from the first page alone.
 */
function mergePages(
  pages: ReadonlyArray<{ blocks: readonly ReportBlock[] }>,
): ReportBlock[] {
  const merged: ReportBlock[] = (pages[0]?.blocks ?? []).map((block) =>
    block.kind === "records" ? { ...block } : block,
  );
  for (const page of pages.slice(1)) {
    for (const block of page.blocks) {
      if (block.kind !== "records") continue;
      const earlier = merged.find(
        (candidate): candidate is Records =>
          candidate.kind === "records" && candidate.title === block.title,
      );
      if (earlier) earlier.rows = [...earlier.rows, ...block.rows];
      else merged.push({ ...block });
    }
  }
  return merged;
}

/** The status each polled run last made the page refresh its record for. */
const syncedStatus = new WeakMap<object, Map<string, string>>();

/**
 * The one place a report compares the server's status with the record's: the polled batch
 * reports a status the record does not show, and the record is refreshed once per new status
 * however many slots read the batch.
 */
function syncRecordStatus(
  client: QueryClient,
  id: string,
  serverStatus: string | undefined,
  shownStatus: string | undefined,
) {
  if (!serverStatus || !shownStatus || serverStatus === shownStatus) return;
  const seen = syncedStatus.get(client) ?? new Map<string, string>();
  syncedStatus.set(client, seen);
  if (seen.get(id) === serverStatus) return;
  seen.set(id, serverStatus);
  void invalidateOperationTags(client, ripple.runOnly);
}

/**
 * The blocks of one slot. A Run slot of the page's polled batch reads the shared `getMany`
 * query; every other slot reads on its own and pages with the server's `nextCursor`.
 */
function useReportBlocks(
  input: EntityReportInput,
  status: string | undefined,
  nested: boolean,
) {
  const client = useQueryClient();
  const batched = isBatchSlot(input.slot);
  const batch = useQuery({
    ...entityReport.getMany.queryOptions({
      slots: [...RUN_BATCH_SLOTS],
      id: input.id,
    }),
    enabled: batched,
    refetchInterval: (state) =>
      state.state.data?.reports.some((entry) => entry.report.live)
        ? LIVE_POLL_MS
        : false,
  });
  const paged = useInfiniteQuery({
    ...entityReport.get.infiniteQueryOptions(input, {
      pageParamSchema: z.string().nullable(),
      page: (pageInput, cursor) =>
        cursor === null ? pageInput : { ...pageInput, cursor },
      initialPageParam: null,
      getNextPageParam: (last) => last.nextCursor ?? undefined,
    }),
    enabled: !batched,
  });
  const report = batch.data?.reports.find(
    (entry) => entry.slot === input.slot,
  )?.report;
  const serverStatus = report?.status;
  useEffect(() => {
    if (batched) syncRecordStatus(client, input.id, serverStatus, status);
  }, [batched, client, input.id, serverStatus, status]);
  const blocks = batched
    ? (report?.blocks ?? [])
    : mergePages(paged.data?.pages ?? []);
  const loaded = batched ? batch.isSuccess : paged.isSuccess;
  // A Run report with no blocks hides its section (nothing to show for this run).
  useSectionVisible(nested || !loaded || blocks.length > 0);
  const state = batched ? batch : paged;
  return {
    isPending: state.isPending,
    isError: state.isError,
    error: state.error,
    refetch: () => void state.refetch(),
    blocks,
    more:
      !batched && paged.hasNextPage
        ? {
            pending: paged.isFetchingNextPage,
            load: () => void paged.fetchNextPage(),
          }
        : undefined,
  };
}

/**
 * A detail slot that is nothing but the server's report blocks. A `records` block's verbs act on
 * `record` (the loaded detail record). The Run slots a page shows share one polled batch;
 * `status` is the record's own status as the page shows it, and the record refreshes once when
 * the batch read another.
 */
export function EntityReportSlot({
  record,
  entity,
  recordsList,
  status,
  nested = false,
  ...input
}: EntityReportInput & {
  record?: object;
  entity?: string;
  recordsList?: (block: Extract<ReportBlock, { kind: "records" }>) => ReactNode;
  status?: string | undefined;
  /** Drawn inside another section: an empty report must not hide that section. */
  nested?: boolean;
}) {
  const query = useReportBlocks(input, status, nested);
  // The slot's own verbs (attach, analyze, validate) stay available while the rows load or fail.
  const verbs = record === undefined ? [] : slotActionsOf(input.slot);
  return (
    <Stack gap="sm" className="items-start">
      {record !== undefined
        ? verbs.map((action) => (
            <ReportVerb key={action} action={action} record={record} />
          ))
        : null}
      {query.isPending ? (
        <Skeleton className="h-16 w-full" />
      ) : query.isError ? (
        <ErrorDisplay
          error={query.error}
          title="this section"
          onRetry={query.refetch}
        />
      ) : (
        <>
          <ReportBlocks
            blocks={query.blocks}
            record={record}
            entity={entity}
            recordsList={recordsList}
          />
          {query.more ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={query.more.pending}
              onClick={query.more.load}
            >
              {query.more.pending ? "Loading…" : "Load more"}
            </Button>
          ) : null}
        </>
      )}
    </Stack>
  );
}
