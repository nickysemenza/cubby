import { classificationFieldDisplayRefusal } from "@cubby/schemas/classification-field-policy";
import { entitySchema, type EntityRef } from "@cubby/schemas/entity";
import type { DetailSummarySlot } from "@cubby/schemas/entity-detail-summary";
import {
  entityFieldModels,
  type EntityFieldModel,
} from "@cubby/schemas/entity-fields";
import type { ReportBlock } from "@cubby/schemas/entity-report";
import { entitySummary } from "@cubby/schemas/entity-summary";
import { summaryReportProjection } from "@cubby/schemas/entity-summary-report";
import { useQueries } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState, type ReactNode } from "react";

import { EntityRefLink } from "~/entity/components/entity-ref-link";
import {
  renderDetailFieldValue,
  referenceMediaRefs,
} from "~/entity/display/entity-display";
import { entities, isBrowserRoutedEntity } from "~/entity/entities";
import { EntityDisplayImagesProvider } from "~/entity/entity-media/entity-display-images";
import { ConnectionPaths } from "~/entity/relationships/connection-paths";
import { entityGraph } from "~/integrations/tanstack-query/generated/catalog/entityGraph.gen";
import { entityReport } from "~/integrations/tanstack-query/generated/catalog/entityReport.gen";
import { cn } from "~/lib/utils";
import { DateDisplay } from "~/ui/common/date-display";
import { RecordList, RecordRow } from "~/ui/common/record-list";
import { ErrorDisplay } from "~/ui/feedback/error-display";
import { Button } from "~/ui/primitives/button";
import { Skeleton } from "~/ui/primitives/skeleton";

import { readPathValue } from "../read-path";
import type { DetailRecordOf, GenericDetailEntity } from "./detail-record";
import { ReportRowText, ReportTimeDisplay } from "./records-ledger";
import { LIVE_REPORT_POLL_MS, ReportBlocks } from "./report-slot";
import { MonthlySpendChart } from "./spend-chart";

type Field = EntityFieldModel["fields"][number];

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
}: {
  title: string;
  children: ReactNode;
  hidden?: boolean;
}) {
  return (
    <section
      aria-label={title}
      hidden={hidden}
      className="min-w-0 border-b border-border px-3 py-2 text-xs [&_[data-entity-pill]>span:last-child]:truncate"
    >
      <h2 className="mb-1 text-xs font-medium text-muted-foreground">
        {title}
      </h2>
      {children}
    </section>
  );
}

/** Display-only projection; full workflow controls remain in their owning sections. */
export function CompactSummaryReport({
  blocks,
  title,
}: {
  blocks: readonly ReportBlock[];
  title?: string;
}) {
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
        {displayed.map((block) => {
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
              <ReportBlocks key={JSON.stringify(block)} blocks={[block]} />
            );
          const _exhaustive: never = block;
          return _exhaustive;
        })}
        {more ? (
          <Button
            variant="ghost"
            size="sm"
            aria-expanded={expanded}
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
  const slots: readonly DetailSummarySlot[] =
    entitySummary[entity].detail.summary;
  const id = record.id;
  const [showContext, setShowContext] = useState(false);
  const records = slots.filter((slot) => slot.kind === "records");
  const recordQueries = useQueries({
    queries: records.map((slot) =>
      entityGraph.connectedRecords.queryOptions({
        source: { entityKind: entity, entityId: id },
        viewKey: slot.viewKey,
        limit: 2,
      }),
    ),
  });
  const reports = slots.filter((slot) => slot.kind === "report");
  const reportInputs = reports.length
    ? [{ id, slots: reports.map((slot) => slot.slot) }]
    : [];
  const reportQueries = useQueries({
    queries: reportInputs.map((input) => {
      const options: ReturnType<typeof entityReport.getMany.queryOptions> = {
        ...entityReport.getMany.queryOptions(input),
        refetchInterval: (state) =>
          state.state.data?.reports.some((entry) => entry.report.live)
            ? LIVE_REPORT_POLL_MS
            : false,
      };
      return options;
    }),
  });
  const reportQuery = reportQueries[0];
  const fields: readonly Field[] = entityFieldModels[entity].fields;
  const fieldKeys = slots.flatMap((slot) =>
    slot.kind === "fields" ? slot.fields : [],
  );
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
        aria-label="Record summary"
        className={cn(
          "grid grid-cols-1 border-y border-border sm:grid-cols-2 sm:[&>section:nth-child(odd)]:border-r",
          !compact &&
            "xl:grid-cols-3 xl:[&>section]:border-r xl:[&>section:nth-child(3n)]:border-r-0",
        )}
      >
        {slots.map((slot) => {
          let content: ReactNode;
          if (slot.kind === "fields") {
            // Missing facts remain in the full record; they need no summary cell.
            if (
              slot.fields.length === 1 &&
              slot.fields.every((key) => {
                const field = fields.find((field) => field.key === key);
                return (
                  field &&
                  field.readKey !== null &&
                  readPathValue(
                    record,
                    field.display.readPath ?? field.readKey,
                  ) == null
                );
              })
            )
              return null;
            content = (
              <dl className="space-y-1">
                {slot.fields.map((key) => {
                  const field = fields.find((field) => field.key === key);
                  if (!field) return null;
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
                      className="flex min-w-0 items-baseline gap-2"
                    >
                      <dt
                        className={
                          slot.fields.length === 1 && slot.title === field.label
                            ? "sr-only"
                            : "shrink-0 text-muted-foreground"
                        }
                      >
                        {field.label}
                      </dt>
                      <dd className="min-w-0 break-words">
                        {(absent || value === null) &&
                        classificationFieldDisplayRefusal(
                          entity,
                          record,
                          field.key,
                        ) === null
                          ? "Not recorded"
                          : renderDetailFieldValue(entity, record, field)}
                      </dd>
                    </div>
                  );
                })}
              </dl>
            );
          } else if (slot.kind === "chart")
            content = (
              <MonthlySpendChart
                entity={entity}
                id={id}
                viewKey={slot.viewKey}
                compact
              />
            );
          else if (slot.kind === "report") {
            if (!reportQuery || reportQuery.isPending)
              content = <Skeleton className="h-12 w-full" />;
            else if (reportQuery.isError)
              content = (
                <ErrorDisplay
                  error={reportQuery.error}
                  title={slot.title}
                  onRetry={() => void reportQuery.refetch()}
                />
              );
            else {
              const report = reportQuery.data.reports.find(
                (report) => report.slot === slot.slot,
              )?.report;
              if (!report)
                throw new Error(`Missing summary report ${slot.slot}`);
              if (!report.blocks.length) return null;
              content = (
                <CompactSummaryReport
                  blocks={report.blocks}
                  title={slot.title}
                />
              );
            }
          } else {
            const query =
              recordQueries[
                records.findIndex((record) => record.id === slot.id)
              ];
            if (!query || query.isPending)
              content = <Skeleton className="h-12 w-full" />;
            else if (query.isError)
              content = (
                <ErrorDisplay
                  error={query.error}
                  title={slot.title}
                  onRetry={() => void query.refetch()}
                />
              );
            else {
              if (!query.data.totalCount) return null;
              content = (
                <>
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
          }
          return (
            <SummaryCell
              key={slot.id}
              title={slot.title}
              hidden={secondary.has(slot.id) && !showContext}
            >
              {content}
            </SummaryCell>
          );
        })}
        {secondary.size > 0 ? (
          <div className="col-span-full border-b border-border px-3 py-1">
            <Button
              variant="ghost"
              size="sm"
              aria-expanded={showContext}
              onClick={() => setShowContext((value) => !value)}
            >
              {showContext ? "Less context" : "More context"}
            </Button>
          </div>
        ) : null}
      </div>
    </EntityDisplayImagesProvider>
  );
}
