import {
  classificationFieldDisplayRefusal,
  classificationFieldRefusal,
} from "@cubby/schemas/classification-field-policy";
import { entitySchema, type EntityRef } from "@cubby/schemas/entity";
import {
  onDetailSurface,
  type DetailSummarySlot,
} from "@cubby/schemas/entity-detail-summary";
import type { EntityFieldModel } from "@cubby/schemas/entity-fields";
import type { ReportSlot, ReportBlock } from "@cubby/schemas/entity-report";
import { summaryReportProjection } from "@cubby/schemas/entity-summary-report";
import { fieldDecisionOf } from "@cubby/schemas/field-envelope";
import {
  useQueries,
  useSuspenseQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { cn } from "cn";
import { useState, type ReactNode } from "react";

import { EntityRefLink } from "~/entity/components/entity-ref-link";
import {
  renderDetailFieldValue,
  referenceMediaRefs,
} from "~/entity/display/entity-display";
import { entities, isBrowserRoutedEntity } from "~/entity/entities";
import { EntityDisplayImagesProvider } from "~/entity/entity-media/entity-display-images";
import { fieldResolutionFor } from "~/entity/fields/field-resolution";
import { entityMetadata, useEntityMetadata } from "~/entity/metadata";
import { ConnectionPaths } from "~/entity/relationships/connection-paths";
import { entityGraph } from "~/integrations/tanstack-query/generated/domains/entityGraph.gen";
import { entityReport } from "~/integrations/tanstack-query/generated/domains/entityReport.gen";
import { DateDisplay } from "~/ui/common/date-display";
import { RecordList, RecordRow } from "~/ui/common/record-list";
import { ErrorDisplay } from "~/ui/feedback/error-display";
import { QuerySection } from "~/ui/feedback/query-section";
import { useHydrated } from "~/ui/hooks/use-hydrated";
import { Button } from "~/ui/primitives/button";
import { Skeleton } from "~/ui/primitives/skeleton";

import { readPathValue } from "../read-path";
import type { DetailRecordOf, GenericDetailEntity } from "./detail-record";
import { useDetailFieldOverrides } from "./entity-record-fields";
import { ReportRowText, ReportTimeDisplay } from "./records-ledger";
import {
  LIVE_REPORT_POLL_MS,
  ReportBlocks,
  reportBlockKey,
} from "./report-slot";
import { MonthlySpendChart } from "./spend-chart";

type Field = EntityFieldModel["fields"][number];

const hasValue = (value: unknown) =>
  value != null &&
  value !== "" &&
  !(Array.isArray(value) && value.length === 0);

/**
 * The fields of a summary cell worth a glance. An absent value is not: the row
 * is omitted so the field stays in the record's field sections, where the
 * member can still fill it in, and the glance never contradicts a populated
 * cell beside it with "Not recorded". A refused classification keeps its named
 * state. A cell with no shown fields disappears.
 */
function summaryFieldsShown<E extends GenericDetailEntity>(
  queryClient: QueryClient,
  entity: E,
  record: DetailRecordOf<E>,
  slot: DetailSummarySlot,
): readonly string[] {
  if (slot.kind !== "fields") return [];
  const fields: readonly Field[] = entityMetadata(queryClient, entity).fields
    .fields;
  return slot.fields.filter((key) => {
    const field = fields.find((candidate) => candidate.key === key);
    if (!field) return false;
    const resolution = fieldResolutionFor(record, field.key);
    if (
      (resolution
        ? fieldDecisionOf(resolution)?.provenance?.kind
        : undefined) === "allocated" ||
      classificationFieldRefusal(entity, record, field.key) !== null
    )
      return true;
    // A list field reads its display items; without any it prints absence, even
    // though a populated cell beside it may list the same records.
    if (field.display.itemsPath)
      return hasValue(readPathValue(record, field.display.itemsPath));
    return (
      field.readKey === null ||
      hasValue(readPathValue(record, field.display.readPath ?? field.readKey))
    );
  });
}

/**
 * The section fields a record surface still shows: a field a summary cell shows
 * is not repeated, and a Name row only repeats the title above it (the header's
 * Edit keeps it editable).
 */
export function detailSectionFields<E extends GenericDetailEntity>(
  queryClient: QueryClient,
  entity: E,
  record: DetailRecordOf<E>,
  keys: readonly string[],
  options: { omitTitle: boolean },
) {
  const { detail, titleField } = entityMetadata(queryClient, entity).summary;
  const declared: readonly DetailSummarySlot[] = detail.summary;
  const summarized = new Set(
    declared.flatMap((slot) =>
      onDetailSurface(slot, "web")
        ? summaryFieldsShown(queryClient, entity, record, slot)
        : [],
    ),
  );
  const titled =
    options.omitTitle &&
    typeof readPathValue(record, titleField) === "string" &&
    readPathValue(record, titleField) !== "";
  return keys.filter(
    (key) => !summarized.has(key) && !(titled && key === titleField),
  );
}

function isRoutedReportEntity(
  value: string,
): value is Parameters<typeof isBrowserRoutedEntity>[0] {
  const parsed = entitySchema.safeParse(value);
  return parsed.success && isBrowserRoutedEntity(parsed.data);
}

/** Covers use the canonical media resolver, including its transitive image rules. */
function reportImageRefs(blocks: readonly ReportBlock[]): EntityRef[] {
  const ref = (entity: string | null, id: string | null): EntityRef[] => {
    const parsed = entitySchema.safeParse(entity);
    return parsed.success && id
      ? [{ entityKind: parsed.data, entityId: id }]
      : [];
  };
  return blocks.flatMap((block) =>
    block.kind === "records"
      ? block.rows.flatMap((row) => [
          ...ref(row.entity, row.id),
          ...(row.paths?.flat() ?? []),
          ...(row.lines ?? []).flatMap((line) =>
            line.ref ? ref(line.ref.entity, line.ref.id) : [],
          ),
        ])
      : [],
  );
}

function SummaryCell({
  title,
  children,
  hidden = false,
  compact = false,
}: {
  title: string;
  children: ReactNode;
  hidden?: boolean;
  compact?: boolean;
}) {
  // A report or record list that resolves to nothing leaves its body empty, and
  // the whole cell goes with it rather than printing an orphan heading.
  return (
    <section
      aria-label={title}
      hidden={hidden}
      data-summary-cell
      className={cn(
        "min-w-0 border-r border-b border-border py-2 text-xs has-[>[data-summary-body]:empty]:hidden md:py-1.5 [&_[data-entity-pill]>span:last-child]:truncate",
        compact ? "flex-[1_1_9rem] px-2" : "flex-[1_1_14rem] px-3",
      )}
    >
      <h2 className="mb-1 text-xs font-medium text-muted-foreground md:mb-0.5">
        {title}
      </h2>
      <div data-summary-body>{children}</div>
    </section>
  );
}

/** Display-only projection; full workflow controls remain in their owning sections. */
export function CompactSummaryReport({
  blocks,
  title,
  scope,
}: {
  blocks: readonly ReportBlock[];
  title?: string;
  scope?: string;
}) {
  const hydrated = useHydrated();
  const projection = summaryReportProjection(blocks);
  const [expanded, setExpanded] = useState(false);
  const preview = projection.blocks.filter(
    (block) =>
      block.kind !== "note" ||
      block.strong ||
      block.tone === "warning" ||
      block.tone === "destructive",
  );
  const more =
    projection.more ||
    preview.length !== projection.blocks.length ||
    blocks.some(
      (block) =>
        block.kind === "records" && (block.rows.length > 2 || !!block.footer),
    );
  const displayed = expanded ? blocks : preview;
  return (
    <EntityDisplayImagesProvider refs={reportImageRefs(displayed)}>
      <div className="space-y-1">
        {displayed.map((block, index) => {
          if (block.kind === "records") {
            const more = block.rows.filter(
              (row) => row.entity === null && row.listLink,
            );
            const rows = block.rows.filter((row) => !more.includes(row));
            return (
              <div key={JSON.stringify(block)}>
                {block.title && (expanded || block.title !== title) ? (
                  <p className="mb-1 text-muted-foreground">{block.title}</p>
                ) : null}
                <RecordList
                  empty={block.empty}
                  footer={
                    (expanded ? block.footer : undefined) ??
                    (block.totalCount === undefined
                      ? undefined
                      : `${block.totalCount} total`)
                  }
                >
                  {(expanded ? rows : rows.slice(0, 2)).map((row, i) => (
                    <RecordRow
                      key={row.id ?? i}
                      clip={false}
                      stacked
                      primary={
                        row.entity &&
                        row.id &&
                        isRoutedReportEntity(row.entity) ? (
                          <EntityRefLink
                            entity={row.entity}
                            id={row.id}
                            name={row.title}
                            emoji={null}
                          />
                        ) : (
                          row.title
                        )
                      }
                      trailing={row.trailing}
                      secondary={
                        row.time ||
                        row.at ||
                        row.lines?.length ||
                        row.externalLink ||
                        row.paths?.some((path) => path.length > 2) ? (
                          <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
                            {row.time ? (
                              <ReportTimeDisplay time={row.time} />
                            ) : row.at ? (
                              <DateDisplay timestamp={row.at} stacked={false} />
                            ) : null}
                            {row.paths?.some((path) => path.length > 2) ? (
                              <ConnectionPaths paths={row.paths} compact />
                            ) : null}
                            <ReportRowText row={row} />
                            {row.externalLink ? (
                              <a
                                href={row.externalLink.url}
                                target="_blank"
                                rel="noreferrer"
                                className="text-link hover:underline"
                              >
                                {row.externalLink.label}
                              </a>
                            ) : null}
                          </div>
                        ) : null
                      }
                    />
                  ))}
                </RecordList>
                {block.connection &&
                (block.totalCount ?? block.rows.length) > 2 ? (
                  <Link
                    to="/connections"
                    search={{
                      source: block.connection.source.entityKind,
                      id: block.connection.source.entityId,
                      view: block.connection.viewKey,
                      mode: "records",
                    }}
                    className="mt-1 inline-block text-link hover:underline"
                  >
                    Related records
                  </Link>
                ) : null}
                {block.listLink &&
                (block.totalCount ?? block.rows.length) > 2 &&
                isRoutedReportEntity(block.listLink.entity) ? (
                  <a
                    className="mt-1 inline-block text-link hover:underline"
                    href={`${entities[block.listLink.entity].routes.list}?${new URLSearchParams(block.listLink.filters)}`}
                  >
                    View all {block.totalCount ?? block.rows.length}
                  </a>
                ) : null}
                {more.map((row) => {
                  const link = row.listLink;
                  return link && isRoutedReportEntity(link.entity) ? (
                    <a
                      key={`${row.title}:${link.entity}`}
                      className="mt-1 inline-block text-link hover:underline"
                      href={`${entities[link.entity].routes.list}?${new URLSearchParams(link.filters)}`}
                    >
                      {row.title} {row.trailing}
                    </a>
                  ) : null;
                })}
              </div>
            );
          }
          // Informational report renderers retain labelled table cells, references, charts and
          // incompleteness notes. Only records need a compact, control-free projection.
          if (
            block.kind === "stats" ||
            block.kind === "chart" ||
            block.kind === "table" ||
            block.kind === "schedule" ||
            block.kind === "progress" ||
            block.kind === "note"
          )
            return (
              <ReportBlocks
                key={reportBlockKey(block, index)}
                scope={scope === undefined ? undefined : `${scope}:${index}`}
                blocks={[block]}
              />
            );
          const _exhaustive: never = block;
          return _exhaustive;
        })}
        {more ? (
          <Button
            variant="ghost"
            size="xs"
            className="-ml-2"
            aria-expanded={expanded}
            disabled={!hydrated}
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? "Show less" : "Show more"}
          </Button>
        ) : null}
      </div>
    </EntityDisplayImagesProvider>
  );
}

export function DetailSummary<E extends GenericDetailEntity>({
  entity,
  record,
  compact = false,
}: {
  entity: E;
  record: DetailRecordOf<E>;
  compact?: boolean;
}) {
  const queryClient = useQueryClient();
  const metadata = useEntityMetadata(entity);
  const hydrated = useHydrated();
  const declared: readonly DetailSummarySlot[] =
    metadata.summary.detail.summary;
  const slots = declared.filter((slot) => onDetailSurface(slot, "web"));
  const id = record.id;
  const [showContext, setShowContext] = useState(false);
  const records = slots.filter((slot) => slot.kind === "records");
  const recordQueries = useQueries({
    queries: records.map((slot) => ({
      ...entityGraph.connectedRecords.queryOptions({
        source: { entityKind: entity, entityId: id },
        viewKey: slot.viewKey,
        limit: 2,
      }),
      enabled: false,
    })),
  });
  const reports = slots.filter((slot) => slot.kind === "report");
  const reportInputs = reports.length
    ? [{ id, slots: reports.map((slot) => slot.slot) }]
    : [];
  const reportQueries = useQueries({
    queries: reportInputs.map((input) => {
      const options: ReturnType<typeof entityReport.getMany.queryOptions> = {
        ...entityReport.getMany.queryOptions(input),
        enabled: false,
      };
      return options;
    }),
  });
  const reportQuery = reportQueries[0];
  const fields: readonly Field[] = entityMetadata(queryClient, entity).fields
    .fields;
  const fieldKeys = slots.flatMap((slot) =>
    slot.kind === "fields" ? slot.fields : [],
  );
  // Later field sections omit these fields, so the cell carries their editor
  // or domain renderer.
  const overrides = useDetailFieldOverrides(entity, record, fieldKeys);
  const imageRefs = [
    ...fields
      .filter((field) => fieldKeys.includes(field.key))
      .flatMap((field) => referenceMediaRefs(record, field)),
    ...recordQueries.flatMap(
      (query) =>
        query.data?.items.flatMap((item) => [
          item.target,
          ...item.paths.flat(),
        ]) ?? [],
    ),
  ];
  // The first four slots are the glance; later context folds behind a toggle.
  const secondary = new Set(
    slots
      .slice(4)
      .filter((slot) => {
        if (slot.kind === "fields") return false;
        if (slot.kind === "report") {
          if (reportQuery?.isError) return false;
          const report = reportQuery?.data?.reports.find(
            (entry) => entry.slot === slot.slot,
          )?.report;
          if (
            report?.blocks.some(
              (block) =>
                block.kind === "note" &&
                (block.strong ||
                  block.tone === "warning" ||
                  block.tone === "destructive"),
            )
          )
            return false;
          return report === undefined || report.blocks.length > 0;
        }
        if (slot.kind === "records") {
          const query =
            recordQueries[records.findIndex((entry) => entry.id === slot.id)];
          if (query?.isError) return false;
          return query?.data === undefined || query.data.totalCount > 0;
        }
        return true;
      })
      .map((slot) => slot.id),
  );
  if (!slots.length) return null;
  return (
    <EntityDisplayImagesProvider refs={imageRefs}>
      <div
        // A full page's header rule sits above the strip.
        className={cn(
          "overflow-hidden border-border",
          compact ? "border-t" : "border-b",
        )}
      >
        <div
          aria-label="Record summary"
          // Cells grow to share each row, so a cell that disappears leaves no
          // hole; the -1px margins hide the rules on each row's trailing edge.
          className="-mr-px -mb-px flex flex-wrap items-stretch"
        >
          {slots.map((slot) => {
            let content: ReactNode;
            if (slot.kind === "fields") {
              const shown = summaryFieldsShown(
                queryClient,
                entity,
                record,
                slot,
              );
              if (shown.length === 0) return null;
              content = (
                <dl className="flex flex-wrap gap-x-3 gap-y-0.5">
                  {shown.map((key) => {
                    const field = fields.find((field) => field.key === key);
                    if (!field) return null;
                    const override =
                      classificationFieldDisplayRefusal(
                        entity,
                        record,
                        field.key,
                      ) === null
                        ? overrides[field.key]?.(record, queryClient)?.value
                        : undefined;
                    const allocated =
                      (fieldResolutionFor(record, field.key)
                        ? fieldDecisionOf(
                            fieldResolutionFor(record, field.key)!,
                          )?.provenance?.kind
                        : undefined) === "allocated";
                    const absent =
                      field.readKey !== null &&
                      field.display.readPath === null &&
                      !(field.readKey in record);
                    const value =
                      field.readKey === null
                        ? undefined
                        : readPathValue(
                            record,
                            field.display.readPath ?? field.readKey,
                          );
                    return (
                      <div
                        key={key}
                        className="flex min-w-0 items-baseline gap-1.5"
                      >
                        <dt
                          className={
                            shown.length === 1 && slot.title === field.label
                              ? "sr-only"
                              : "shrink-0 text-muted-foreground"
                          }
                        >
                          {field.label}
                        </dt>
                        <dd className="min-w-0 break-words">
                          {override ??
                            ((absent || value === null) &&
                            !allocated &&
                            classificationFieldRefusal(
                              entity,
                              record,
                              field.key,
                            ) === null ? (
                              <span className="text-muted-foreground">
                                Not recorded
                              </span>
                            ) : (
                              renderDetailFieldValue(
                                queryClient,
                                entity,
                                record,
                                field,
                              )
                            ))}
                        </dd>
                      </div>
                    );
                  })}
                </dl>
              );
            } else if (slot.kind === "chart")
              content = (
                <QuerySection
                  title={slot.title}
                  resetKey={`${id}:${slot.id}`}
                  fallback={<Skeleton className="h-12 w-full" />}
                >
                  <MonthlySpendChart
                    entity={entity}
                    id={id}
                    viewKey={slot.viewKey}
                    compact
                  />
                </QuerySection>
              );
            else if (slot.kind === "report") {
              content = (
                <QuerySection
                  title={slot.title}
                  resetKey={`${id}:${slot.id}`}
                  fallback={<Skeleton className="h-12 w-full" />}
                >
                  <SummaryReport
                    id={id}
                    slot={slot}
                    slots={reports.map((report) => report.slot)}
                  />
                </QuerySection>
              );
            } else {
              content = (
                <QuerySection
                  title={slot.title}
                  resetKey={`${id}:${slot.id}`}
                  fallback={<Skeleton className="h-12 w-full" />}
                >
                  <SummaryRecords entity={entity} id={id} slot={slot} />
                </QuerySection>
              );
            }
            return (
              <SummaryCell
                key={slot.id}
                title={slot.title}
                compact={compact}
                hidden={secondary.has(slot.id) && !showContext}
              >
                {secondary.has(slot.id) && !showContext ? null : content}
              </SummaryCell>
            );
          })}
          {secondary.size > 0 ? (
            <div className="flex flex-none items-center border-r border-b border-border px-2 py-1">
              <Button
                variant="ghost"
                size="xs"
                aria-expanded={showContext}
                disabled={!hydrated}
                onClick={() => setShowContext((value) => !value)}
              >
                {showContext ? "Less context" : "More context"}
              </Button>
            </div>
          ) : null}
        </div>
      </div>
    </EntityDisplayImagesProvider>
  );
}

function SummaryReport({
  id,
  slot,
  slots,
}: {
  id: string;
  slot: Extract<DetailSummarySlot, { kind: "report" }>;
  slots: ReportSlot[];
}) {
  const query = useSuspenseQuery({
    ...entityReport.getMany.queryOptions({ id, slots }),
    refetchInterval: (state) =>
      state.state.data?.reports.some((entry) => entry.report.live)
        ? LIVE_REPORT_POLL_MS
        : false,
  });
  const report = query.data.reports.find(
    (report) => report.slot === slot.slot,
  )?.report;
  if (!report) throw new Error(`Missing summary report ${slot.slot}`);
  if (!report.blocks.length && !query.error) return null;
  return (
    <>
      {query.error ? (
        <ErrorDisplay
          error={query.error}
          title={slot.title}
          onRetry={() => {
            void query.refetch();
          }}
        />
      ) : null}
      {report.blocks.length ? (
        <CompactSummaryReport
          blocks={report.blocks}
          title={slot.title}
          scope={`${id}:${slot.slot}`}
        />
      ) : null}
    </>
  );
}

function SummaryRecords({
  entity,
  id,
  slot,
}: {
  entity: GenericDetailEntity;
  id: string;
  slot: Extract<DetailSummarySlot, { kind: "records" }>;
}) {
  const query = useSuspenseQuery(
    entityGraph.connectedRecords.queryOptions({
      source: { entityKind: entity, entityId: id },
      viewKey: slot.viewKey,
      limit: 2,
    }),
  );
  if (!query.data.totalCount && !query.error) return null;
  return (
    <>
      {query.error ? (
        <ErrorDisplay
          error={query.error}
          title={slot.title}
          onRetry={() => {
            void query.refetch();
          }}
        />
      ) : null}
      <RecordList>
        {query.data.items.map((item) => (
          <RecordRow
            key={item.target.entityId}
            clip={false}
            stacked
            primary={
              isBrowserRoutedEntity(item.target.entityKind) ? (
                <EntityRefLink
                  entity={item.target.entityKind}
                  id={item.target.entityId}
                  name={item.target.label}
                  emoji={null}
                />
              ) : (
                item.target.label
              )
            }
            secondary={
              item.paths.some((path) => path.length > 2) ? (
                <ConnectionPaths paths={item.paths} compact />
              ) : null
            }
          />
        ))}
      </RecordList>
      {query.data.totalCount > query.data.items.length ? (
        <Link
          to="/connections"
          search={{
            source: entity,
            id,
            view: slot.viewKey,
            mode: "records",
          }}
          className="mt-2 inline-block text-link hover:underline"
        >
          View all {query.data.totalCount}
        </Link>
      ) : null}
    </>
  );
}
