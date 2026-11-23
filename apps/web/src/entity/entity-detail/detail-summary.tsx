import { entitySchema, type EntityRef } from "@cubby/schemas/entity";
import type { CompiledEntityPresentation } from "@cubby/schemas/entity-definitions/definition";
import {
  onDetailSurface,
  type DetailSummarySlot,
} from "@cubby/schemas/entity-detail-summary";
import type { EntityFieldModel } from "@cubby/schemas/entity-fields";
import type { ReportSlot, ReportBlock } from "@cubby/schemas/entity-report";
import { summaryReportProjection } from "@cubby/schemas/entity-summary-report";
import { useSuspenseQuery, type QueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";

import { EntityRefLink } from "~/entity/components/entity-ref-link";
import {
  entities,
  entityDetailParams,
  isBrowserRoutedEntity,
} from "~/entity/entities";
import { EntityDisplayImagesProvider } from "~/entity/entity-media/entity-display-images";
import { entityMetadata, useEntityMetadata } from "~/entity/metadata";
import { ConnectionPaths } from "~/entity/relationships/connection-paths";
import { entityGraph } from "~/integrations/tanstack-query/generated/domains/entityGraph.gen";
import { entityReport } from "~/integrations/tanstack-query/generated/domains/entityReport.gen";
import { ErrorDisplay } from "~/ui/feedback/error-display";
import { QuerySection } from "~/ui/feedback/query-section";
import { useHydrated } from "~/ui/hooks/use-hydrated";
import { Button } from "~/ui/primitives/button";
import { Skeleton } from "~/ui/primitives/skeleton";
import { RecordList, RecordRow } from "~/ui/records/record-list";
import { DateDisplay } from "~/ui/values/date-display";

import { readPathValue } from "../read-path";
import type { DetailRecordOf, GenericDetailEntity } from "./detail-record";
import { detailSlotsFor } from "./detail-slots";
import { recordStateOf } from "./record-header";
import { ReportRowText, ReportTimeDisplay } from "./records-ledger";
import {
  LIVE_REPORT_POLL_MS,
  ReportBlocks,
  reportBlockKey,
} from "./report-slot";
import { MonthlySpendChart } from "./spend-chart";

type Field = EntityFieldModel["fields"][number];

/** Every field the declared `fields` summary cells name, in order: the facts card leads with them. */
export function summaryFieldKeys(
  queryClient: QueryClient,
  entity: GenericDetailEntity,
): string[] {
  const declared: readonly DetailSummarySlot[] = entityMetadata(
    queryClient,
    entity,
  ).summary.detail.summary;
  return [
    ...new Set(
      declared.flatMap((slot) =>
        slot.kind === "fields" && onDetailSurface(slot, "web")
          ? slot.fields
          : [],
      ),
    ),
  ];
}

/**
 * The fields the full page's identity and signals draw themselves: the AI
 * summary and needs, the state badge's fields, the kind tag and the `hero`
 * chip and date. They never repeat as a fact.
 */
function identityPlacedFields(
  queryClient: QueryClient,
  entity: GenericDetailEntity,
): Set<string> {
  const { detail, state, kind }: CompiledEntityPresentation = entityMetadata(
    queryClient,
    entity,
  ).summary;
  return new Set(
    [
      detail.aiSummary,
      detail.side?.needs,
      detail.hero.when?.field,
      detail.hero.chip,
      state?.field,
      state?.reason,
      state?.wait,
      state?.stalled,
      kind?.field,
    ].filter((key): key is string => typeof key === "string"),
  );
}

/**
 * Option fields whose current value reads the same as the header's state (a
 * stored status beside the displayed one): the header already says it.
 */
function repeatsHeaderState<E extends GenericDetailEntity>(
  queryClient: QueryClient,
  entity: E,
  record: DetailRecordOf<E>,
): (key: string) => boolean {
  const state = recordStateOf(queryClient, entity, record);
  if (state === null) return () => false;
  const fields: readonly Field[] = entityMetadata(queryClient, entity).fields
    .fields;
  return (key) => {
    const field = fields.find((candidate) => candidate.key === key);
    if (!field) return false;
    const raw = readPathValue(
      record,
      field.display.readPath ?? field.readKey ?? field.key,
    );
    const options: readonly { value: string; label: string }[] =
      field.control?.options ?? field.display.valueOptions ?? [];
    return options.some(
      (option) => option.value === raw && option.label === state.option.label,
    );
  };
}

/**
 * The fields a relation section's context still shows: the facts card owns
 * the declared lines, the summary's fields and the identity's fields outright,
 * recorded or not, a Name row only repeats the title above it (the header's
 * Edit keeps it editable), and an option field that reads the same as the
 * state leaves too, so no fact appears twice.
 */
export function detailSectionFields<E extends GenericDetailEntity>(
  queryClient: QueryClient,
  entity: E,
  record: DetailRecordOf<E>,
  keys: readonly string[],
  options: { omitTitle: boolean },
) {
  const { detail, titleField } = entityMetadata(queryClient, entity).summary;
  const summarized = new Set([
    ...summaryFieldKeys(queryClient, entity),
    ...detail.lines.map((line) => line.field),
    ...identityPlacedFields(queryClient, entity),
  ]);
  const repeatsState = repeatsHeaderState(queryClient, entity, record);
  const titled =
    options.omitTitle &&
    typeof readPathValue(record, titleField) === "string" &&
    readPathValue(record, titleField) !== "";
  return keys.filter(
    (key) =>
      !summarized.has(key) &&
      !(titled && key === titleField) &&
      !repeatsState(key),
  );
}

/**
 * Every singular fact the facts card lists, in reading order: the
 * declared lines, the summary's field cells, then each field section's fields.
 * The title, and what the identity already states, are left out.
 */
export function railFieldKeys<E extends GenericDetailEntity>(
  queryClient: QueryClient,
  entity: E,
  record: DetailRecordOf<E>,
): string[] {
  const { detail, titleField } = entityMetadata(queryClient, entity).summary;
  const sections: CompiledEntityPresentation["detail"]["sections"] =
    detail.sections;
  const placed = identityPlacedFields(queryClient, entity);
  const repeatsState = repeatsHeaderState(queryClient, entity, record);
  const titled =
    typeof readPathValue(record, titleField) === "string" &&
    readPathValue(record, titleField) !== "";
  return [
    ...new Set([
      ...detail.lines.map((line) => line.field),
      ...summaryFieldKeys(queryClient, entity),
      ...sections.flatMap((section) =>
        section.kind === "fields" && onDetailSurface(section, "web")
          ? section.fields
          : [],
      ),
    ]),
  ].filter(
    (key) =>
      !placed.has(key) && !(titled && key === titleField) && !repeatsState(key),
  );
}

/** The field a `relation:<key>` view follows directly (`Task.projectId`), if any. */
function referenceFieldOf(
  queryClient: QueryClient,
  entity: GenericDetailEntity,
  viewKey: string,
): string | undefined {
  if (!viewKey.startsWith("relation:")) return undefined;
  const relationship = entityMetadata(
    queryClient,
    entity,
  ).descriptor.relationships.find(
    (candidate) => candidate.key === viewKey.slice("relation:".length),
  );
  const provenance = relationship?.provenance;
  if (provenance?.kind !== "local-path" || provenance.steps.length !== 1)
    return undefined;
  const [step] = provenance.steps;
  return step?.direction === "outgoing" ? step.edge.split(".")[1] : undefined;
}

/**
 * Whether a signals-bar report or records cell repeats a section the page
 * draws: a report slot named `<entity>.<section id>`, a records cell over a
 * relation a section lists, or one over a reference field a fields section
 * shows. The section keeps the whole content.
 */
function repeatsSection<E extends GenericDetailEntity>(
  queryClient: QueryClient,
  entity: E,
  record: DetailRecordOf<E>,
  slot: DetailSummarySlot,
): boolean {
  if (slot.kind !== "report" && slot.kind !== "records") return false;
  const slots = detailSlotsFor(entity);
  const relationField =
    slot.kind === "records"
      ? referenceFieldOf(queryClient, entity, slot.viewKey)
      : undefined;
  const sections: CompiledEntityPresentation["detail"]["sections"] =
    entityMetadata(queryClient, entity).summary.detail.sections;
  return sections.some((section) => {
    if (!onDetailSurface(section, "web")) return false;
    if (slot.kind === "records")
      return section.kind === "relation"
        ? slot.viewKey === `relation:${section.relation}`
        : section.kind === "fields" &&
            relationField !== undefined &&
            section.fields.includes(relationField);
    if (section.kind !== "slot" || slot.slot !== `${entity}.${section.id}`)
      return false;
    const fill = slots?.[section.id];
    // SAFETY: `detailSlotsFor` hands back this entity's own slots.
    return fill !== undefined && fill.applies?.(record as never) !== false;
  });
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

/**
 * The chart, report and record cells the record's summary card offers: a
 * cell that repeats a section the page draws leaves, and the facts card lists
 * the field cells.
 */
export function signalSlots<E extends GenericDetailEntity>(
  queryClient: QueryClient,
  entity: E,
  record: DetailRecordOf<E>,
): DetailSummarySlot[] {
  const declared: readonly DetailSummarySlot[] = entityMetadata(
    queryClient,
    entity,
  ).summary.detail.summary;
  return declared.filter(
    (slot) =>
      slot.kind !== "fields" &&
      onDetailSurface(slot, "web") &&
      !repeatsSection(queryClient, entity, record, slot),
  );
}

/** One chart, report or records cell's body, behind its own loading boundary. */
export function SummarySlotBody({
  entity,
  id,
  slot,
  reportSlots,
}: {
  entity: GenericDetailEntity;
  id: string;
  slot: Exclude<DetailSummarySlot, { kind: "fields" }>;
  /** Every report slot the surface reads, so they share one batched read. */
  reportSlots: ReportSlot[];
}) {
  return (
    <QuerySection
      title={slot.title}
      resetKey={`${id}:${slot.id}`}
      fallback={<Skeleton className="h-12 w-full" />}
    >
      {slot.kind === "chart" ? (
        <MonthlySpendChart
          entity={entity}
          id={id}
          viewKey={slot.viewKey}
          compact
        />
      ) : slot.kind === "report" ? (
        <SummaryReport id={id} slot={slot} slots={reportSlots} />
      ) : (
        <SummaryRecords entity={entity} id={id} slot={slot} />
      )}
    </QuerySection>
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
  const detail: CompiledEntityPresentation["detail"] =
    useEntityMetadata(entity).summary.detail;
  const section = detail.sections.find(
    (candidate) =>
      candidate.kind === "relation" &&
      onDetailSurface(candidate, "web") &&
      slot.viewKey === `relation:${candidate.relation}`,
  );
  const query = useSuspenseQuery(
    entityGraph.connectedRecords.queryOptions({
      source: { entityKind: entity, entityId: id },
      viewKey: slot.viewKey,
      limit: 2,
    }),
  );
  if (query.error)
    return (
      <ErrorDisplay
        error={query.error}
        title={slot.title}
        onRetry={() => {
          void query.refetch();
        }}
      />
    );
  if (!query.data.totalCount) return null;
  return (
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
                  displayImage={item.target.image ?? null}
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
      {section && isBrowserRoutedEntity(entity) ? (
        <Link
          to={entities[entity].routes.detail}
          params={entityDetailParams(id)}
          hash={section.id}
          aria-label={`${slot.title}: ${query.data.totalCount}`}
          className="mt-2 inline-block text-link hover:underline"
        >
          View all{" "}
          <span className="font-mono tabular-nums">
            {query.data.totalCount}
          </span>
        </Link>
      ) : (
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
      )}
    </>
  );
}
