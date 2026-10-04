import { slotActionsOf } from "@cubby/schemas/entity-report";
import type {
  EntityReportInput,
  ReportBlock,
} from "@cubby/schemas/entity-report";
import { useQuery } from "@tanstack/react-query";

import { entityReport } from "~/integrations/tanstack-query/generated/catalog.gen";
import { cn, formatCurrency } from "~/lib/utils";
import { ErrorDisplay } from "~/ui/feedback/error-display";
import { Row, Stack } from "~/ui/layout";
import { Description } from "~/ui/primitives/description";
import { Eyebrow } from "~/ui/primitives/eyebrow";
import { Skeleton } from "~/ui/primitives/skeleton";

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

const formatValue = (value: number, format: "money" | "count") =>
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
            {figure.value == null
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
const blockKey = (block: ReportBlock) =>
  `${block.kind}:${block.kind === "note" ? block.text : block.kind === "schedule" ? "" : (block.title ?? "")}`;

/**
 * Draws the generic report blocks a detail slot's server read returns. A slot
 * with a richer web-only surface (the schedule grid) reads the same blocks
 * itself instead.
 */
function ReportBlocks({
  blocks,
  record,
}: {
  blocks: readonly ReportBlock[];
  record?: object;
}) {
  return (
    <Stack gap="xs">
      {blocks.map((block) => {
        const key = blockKey(block);
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
              <Description key={key} size="xs">
                {block.text}
              </Description>
            );
          case "records":
            return <RecordsBlockView key={key} block={block} record={record} />;
          case "schedule":
            return null;
        }
      })}
    </Stack>
  );
}

/**
 * A detail slot that is nothing but the server's report blocks. A `records` block's verbs act on
 * `record` (the loaded detail record) and `rowBadges` adds web-only per-row badges.
 */
export function EntityReportSlot({
  record,
  ...input
}: EntityReportInput & { record?: object }) {
  const query = useQuery(entityReport.get.queryOptions(input));
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
          onRetry={() => void query.refetch()}
        />
      ) : (
        <ReportBlocks blocks={query.data.blocks} record={record} />
      )}
    </Stack>
  );
}
