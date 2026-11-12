import { classificationFieldDisplayRefusal } from "@cubby/schemas/classification-field-policy";
import { entitySchema, type EntityRef } from "@cubby/schemas/entity";
import type { CompiledEntityPresentation } from "@cubby/schemas/entity-definitions/definition";
import {
  onDetailSurface,
  type DetailSummarySlot,
} from "@cubby/schemas/entity-detail-summary";
import type { EntityFieldModel } from "@cubby/schemas/entity-fields";
import type { ReportSlot, ReportBlock } from "@cubby/schemas/entity-report";
import { summaryReportProjection } from "@cubby/schemas/entity-summary-report";
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
  EntityBasicInfo,
  renderDetailFieldValue,
  referenceMediaRefs,
} from "~/entity/display/entity-display";
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
import { Facts, FactsDensityProvider, FoldedFacts } from "~/ui/records/facts";
import { RecordList, RecordRow } from "~/ui/records/record-list";
import { DateDisplay } from "~/ui/values/date-display";

import { readPathValue } from "../read-path";
import type { DetailRecordOf, GenericDetailEntity } from "./detail-record";
import { detailSlotsFor } from "./detail-slots";
import { fieldRecorded, useDetailFieldOverrides } from "./entity-record-fields";
import { recordStateOf } from "./record-header";
import { ReportRowText, ReportTimeDisplay } from "./records-ledger";
import {
  LIVE_REPORT_POLL_MS,
  ReportBlocks,
  reportBlockKey,
} from "./report-slot";
import { MonthlySpendChart } from "./spend-chart";

type Field = EntityFieldModel["fields"][number];

/**
 * The fields of a summary cell worth a glance. An absent value is not: the row
 * is omitted so the field stays in the record's field sections, where the
 * member can still fill it in, and the glance never contradicts a populated
 * cell beside it with "Not recorded". A cell with no shown fields disappears.
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
    return field !== undefined && fieldRecorded(entity, record, field);
  });
}

/** Every field the declared `fields` summary cells name, in order. */
function summarySlotFields(
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
 * The fields the full page's header and side column draw: the declared lines,
 * AI summary and needs, the state badge's fields, the kind tag and the
 * header's `hero` chip and date.
 */
function headerPlacedFields(
  queryClient: QueryClient,
  entity: GenericDetailEntity,
): Set<string> {
  const { detail, state, kind }: CompiledEntityPresentation = entityMetadata(
    queryClient,
    entity,
  ).summary;
  return new Set(
    [
      ...detail.lines.map((line) => line.field),
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
 * The section fields a record surface still shows: a field a summary cell shows
 * is not repeated, and a Name row only repeats the title above it (the header's
 * Edit keeps it editable). On the full page (`placed`) the header and side
 * column own their fields outright, recorded or not, and an option field that
 * reads the same as the header's state leaves too, so no fact appears twice.
 */
export function detailSectionFields<E extends GenericDetailEntity>(
  queryClient: QueryClient,
  entity: E,
  record: DetailRecordOf<E>,
  keys: readonly string[],
  options: { omitTitle: boolean; placed?: boolean },
) {
  const { detail, titleField } = entityMetadata(queryClient, entity).summary;
  const declared: readonly DetailSummarySlot[] = detail.summary;
  const summarized = new Set(
    options.placed
      ? [
          ...summarySlotFields(queryClient, entity),
          ...headerPlacedFields(queryClient, entity),
        ]
      : declared.flatMap((slot) =>
          onDetailSurface(slot, "web")
            ? summaryFieldsShown(queryClient, entity, record, slot)
            : [],
        ),
  );
  const repeatsState = options.placed
    ? repeatsHeaderState(queryClient, entity, record)
    : () => false;
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
 * Whether a side-column report or records cell repeats a section the page
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

/** A side-column block's heading. */
export const sideHeading =
  "mb-1.5 text-sm font-semibold text-foreground-strong";

function SummaryCell({
  title,
  children,
  hidden = false,
  compact = false,
  side = false,
}: {
  title: string;
  children: ReactNode;
  hidden?: boolean;
  compact?: boolean;
  side?: boolean;
}) {
  // A report or record list that resolves to nothing leaves its body empty, and
  // the whole cell goes with it rather than printing an orphan heading.
  if (side)
    return (
      <section
        aria-label={title}
        data-summary-cell
        className="min-w-0 text-sm has-[>[data-summary-body]:empty]:hidden [&_[data-entity-pill]>span:last-child]:truncate"
      >
        <h2 className={sideHeading}>{title}</h2>
        <div data-summary-body>{children}</div>
      </section>
    );
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

/**
 * The declared summary cells. `strip` is the inspector's ruled strip of every
 * cell; `side` stacks the report, records and chart cells in the full page's
 * side column, whose key facts draw the field cells.
 */
export function DetailSummary<E extends GenericDetailEntity>({
  entity,
  record,
  compact = false,
  layout = "strip",
}: {
  entity: E;
  record: DetailRecordOf<E>;
  compact?: boolean;
  layout?: "strip" | "side";
}) {
  const side = layout === "side";
  const queryClient = useQueryClient();
  const metadata = useEntityMetadata(entity);
  const hydrated = useHydrated();
  const declared: readonly DetailSummarySlot[] =
    metadata.summary.detail.summary;
  // Beside the sections, a cell that repeats one leaves the side column.
  const slots = declared.filter(
    (slot) =>
      onDetailSurface(slot, "web") &&
      !(side && repeatsSection(queryClient, entity, record, slot)),
  );
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
      .slice(side ? slots.length : 4)
      .filter((slot) => {
        if (slot.kind === "fields") return false;
        // Streamed queries may resolve before the first client render. Keep
        // the server's declaration-only fold until this boundary hydrates.
        if (!hydrated) return true;
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
  const cells = slots.map((slot) => {
    if (side && slot.kind === "fields") return null;
    let content: ReactNode;
    if (slot.kind === "fields") {
      const shown = summaryFieldsShown(queryClient, entity, record, slot);
      if (shown.length === 0) return null;
      content = (
        <dl className="flex flex-wrap gap-x-3 gap-y-0.5">
          {shown.map((key) => {
            const field = fields.find((field) => field.key === key);
            if (!field) return null;
            const override =
              classificationFieldDisplayRefusal(entity, record, field.key) ===
              null
                ? overrides[field.key]?.(record, queryClient)?.value
                : undefined;
            return (
              <div key={key} className="flex min-w-0 items-baseline gap-1.5">
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
                    renderDetailFieldValue(queryClient, entity, record, field)}
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
        side={side}
        hidden={secondary.has(slot.id) && !showContext}
      >
        {secondary.has(slot.id) && !showContext ? null : content}
      </SummaryCell>
    );
  });
  if (side) {
    // Every field cell joins one Key facts list; absent facts fold under it
    // with their Add controls. A field the header draws stays there.
    const header = headerPlacedFields(queryClient, entity);
    const keys = [...new Set(fieldKeys)].filter((key) => !header.has(key));
    const recorded = keys.flatMap((key) => {
      const field = fields.find((candidate) => candidate.key === key);
      return field && fieldRecorded(entity, record, field) ? [field] : [];
    });
    const folded = keys.flatMap((key) => {
      const field = fields.find((candidate) => candidate.key === key);
      return field && field.display.detail && !recorded.includes(field)
        ? [field]
        : [];
    });
    return (
      <EntityDisplayImagesProvider refs={imageRefs}>
        {recorded.length + folded.length > 0 ? (
          <section aria-label="Key facts" data-key-facts>
            <h2 className={sideHeading}>Key facts</h2>
            <FactsDensityProvider density="compact">
              <Facts
                layout="list"
                facts={recorded.map((field) => ({
                  id: field.key,
                  label: field.label,
                  value:
                    (classificationFieldDisplayRefusal(
                      entity,
                      record,
                      field.key,
                    ) === null
                      ? overrides[field.key]?.(record, queryClient)?.value
                      : undefined) ??
                    renderDetailFieldValue(queryClient, entity, record, field),
                }))}
              />
              <FoldedFacts labels={folded.map((field) => field.label)}>
                <EntityBasicInfo
                  entity={entity}
                  record={record}
                  fields={folded.map((field) => field.key)}
                  overrides={Object.fromEntries(
                    Object.entries(overrides).filter(([key]) =>
                      folded.some((field) => field.key === key),
                    ),
                  )}
                />
              </FoldedFacts>
            </FactsDensityProvider>
          </section>
        ) : null}
        {cells}
      </EntityDisplayImagesProvider>
    );
  }
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
          {cells}
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
