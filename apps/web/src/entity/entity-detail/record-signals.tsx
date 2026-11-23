import { entitySchema } from "@cubby/schemas/entity";
import type { CompiledEntityPresentation } from "@cubby/schemas/entity-definitions/definition";
import { displayItems } from "@cubby/schemas/entity-definitions/label-field";
import type { DetailSummarySlot } from "@cubby/schemas/entity-detail-summary";
import type { EntityFieldModel } from "@cubby/schemas/entity-fields";
import { CaretDownIcon } from "@phosphor-icons/react/dist/csr/CaretDown";
import { CheckIcon } from "@phosphor-icons/react/dist/csr/Check";
import { MinusCircleIcon } from "@phosphor-icons/react/dist/csr/MinusCircle";
import {
  type QueryClient,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { cn } from "cn";
import type { ReactNode } from "react";

import { readRecordState } from "~/entity/display/list-renderers/generic-state";
import {
  entities,
  entityDetailParams,
  isBrowserRoutedEntity,
} from "~/entity/entities";
import { WhyValue } from "~/entity/fields/explanation/why-value";
import { useMachinery } from "~/entity/machinery/record-machinery";
import { entityMetadata } from "~/entity/metadata";
import {
  RecordWorkQueueRow,
  useRecordWorkQueue,
} from "~/entity/work-queue/record-work-queue";
import { entityGraph } from "~/integrations/tanstack-query/generated/domains/entityGraph.gen";
import { entityReport } from "~/integrations/tanstack-query/generated/domains/entityReport.gen";
import { formatCount } from "~/lib/number-format";
import { ErrorDisplay } from "~/ui/feedback/error-display";
import { QuerySection } from "~/ui/feedback/query-section";
import { useHydrated } from "~/ui/hooks/use-hydrated";
import { PrevNextButtons } from "~/ui/navigation/prev-next-buttons";
import { Button } from "~/ui/primitives/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "~/ui/primitives/popover";
import { Skeleton } from "~/ui/primitives/skeleton";
import { StateMark } from "~/ui/records/state-badge";

import { readPathValue } from "../read-path";
import type { DetailRecordOf, GenericDetailEntity } from "./detail-record";
import { signalSlots, SummarySlotBody } from "./detail-summary";
import { headerLinesOf } from "./record-header";
import {
  QualityIssueLink,
  QualityStatusLine,
  type RecordQualityCheck,
  useQualityAssessment,
} from "./record-quality";
import { useRecordSequence } from "./record-sequence";
import { MonthlySpendChart } from "./spend-chart";

type Field = EntityFieldModel["fields"][number];
type SignalSlot = Exclude<DetailSummarySlot, { kind: "fields" }>;

/** The record's declared `side.needs` items, empty when undeclared or unset. */
export function declaredNeedsOf<E extends GenericDetailEntity>(
  queryClient: QueryClient,
  entity: E,
  record: DetailRecordOf<E>,
) {
  const { detail }: CompiledEntityPresentation = entityMetadata(
    queryClient,
    entity,
  ).summary;
  const field = detail.side?.needs;
  if (field === undefined) return [];
  const fields: readonly Field[] = entityMetadata(queryClient, entity).fields
    .fields;
  const declared = fields.find((candidate) => candidate.key === field);
  const parsed = displayItems.safeParse(
    readPathValue(record, declared?.display.itemsPath ?? field),
  );
  return parsed.success ? (parsed.data ?? []) : [];
}

/**
 * What waits on the member: the declared `side.needs` items (else the record's
 * Work queue rows), then the open quality checks no queue row already names.
 */
function useNeedsYou<E extends GenericDetailEntity>(
  entity: E,
  record: DetailRecordOf<E>,
) {
  const queryClient = useQueryClient();
  const { detail }: CompiledEntityPresentation = entityMetadata(
    queryClient,
    entity,
  ).summary;
  const declared = detail.side?.needs;
  const items = declaredNeedsOf(queryClient, entity, record);
  // Declared items carry no tone of their own; on a record whose state is a
  // failure they are what the failure left, so they take its mark.
  const itemsFailed =
    readRecordState(queryClient, entity, record)?.failed === true;
  const machinery = useMachinery({ entity, id: record.id });
  const queue = useRecordWorkQueue(record.id, declared === undefined);
  const rows =
    declared === undefined
      ? queue.rows.filter(
          (row) =>
            !machinery.data?.machinery?.gaps.items.some(
              (gap) => gap.input === row.reason,
            ),
        )
      : [];
  const named = new Set(
    rows.flatMap((row) => row.gaps.map((gap): string => gap.check)),
  );
  const assessment = useQualityAssessment();
  const quality = (assessment?.attention ?? []).filter(
    (check) => !named.has(check.check),
  );
  return {
    items,
    itemsFailed,
    rows,
    quality,
    count: items.length + rows.length + quality.length,
    error: declared === undefined ? queue.error : null,
  };
}

/** "Needs you N" beside the record's title, absent when nothing waits. */
export function NeedsYouBadge<E extends GenericDetailEntity>({
  entity,
  record,
}: {
  entity: E;
  record: DetailRecordOf<E>;
}) {
  const needs = useNeedsYou(entity, record);
  if (needs.count === 0) return null;
  return (
    <span
      data-testid="needs-you"
      className="inline-flex h-(--pill-height) items-center gap-1.5 rounded-full bg-needs px-2 text-xs font-semibold text-needs-foreground"
    >
      Needs you
      <span className="font-mono tabular-nums">{formatCount(needs.count)}</span>
    </span>
  );
}

/** A report cell's one line: the server's digest, else its title. */
function ReportFigure({
  id,
  slot,
  slots,
}: {
  id: string;
  slot: Extract<SignalSlot, { kind: "report" }>;
  slots: Extract<SignalSlot, { kind: "report" }>["slot"][];
}) {
  const hydrated = useHydrated();
  const query = useQuery({
    ...entityReport.getMany.queryOptions({ id, slots }),
    enabled: hydrated,
  });
  const report = query.data?.reports.find(
    (entry) => entry.slot === slot.slot,
  )?.report;
  if (query.isPending) return <Skeleton className="h-3 w-16" />;
  return <>{report?.digest ?? (report?.blocks.length ? "View" : "None")}</>;
}

/** A records cell's one line: how many records it names. */
function RecordsFigure({
  entity,
  id,
  slot,
}: {
  entity: GenericDetailEntity;
  id: string;
  slot: Extract<SignalSlot, { kind: "records" }>;
}) {
  const hydrated = useHydrated();
  const query = useQuery({
    ...entityGraph.connectedRecords.queryOptions({
      source: { entityKind: entity, entityId: id },
      viewKey: slot.viewKey,
      limit: 2,
    }),
    enabled: hydrated,
  });
  if (query.isPending) return <Skeleton className="h-3 w-8" />;
  return <>{formatCount(query.data?.totalCount ?? 0)}</>;
}

/** A label and its value on one line of the summary card. */
function SummaryLine({
  label,
  children,
  figure = false,
}: {
  label: ReactNode;
  children: ReactNode;
  figure?: boolean;
}) {
  return (
    <div className="flex min-w-0 items-baseline justify-between gap-3 py-1">
      <dt className="min-w-0 truncate text-muted-foreground">{label}</dt>
      <dd
        className={cn(
          "min-w-0 text-right break-words text-foreground",
          figure && "font-mono tabular-nums",
        )}
      >
        {children}
      </dd>
    </div>
  );
}

/**
 * A chart, report or records cell: its figure on a line, the full cell one
 * click away in a popover.
 */
function SignalLine({
  entity,
  id,
  slot,
  reportSlots,
}: {
  entity: GenericDetailEntity;
  id: string;
  slot: SignalSlot;
  reportSlots: Extract<SignalSlot, { kind: "report" }>["slot"][];
}) {
  if (slot.kind === "chart")
    return (
      <SummaryLine label={slot.title}>
        <span data-signal={slot.id} className="inline-flex justify-end">
          <QuerySection
            title={slot.title}
            resetKey={`${id}:${slot.id}:spark`}
            fallback={<Skeleton className="h-4 w-24" />}
          >
            <MonthlySpendChart
              entity={entity}
              id={id}
              viewKey={slot.viewKey}
              spark
            />
          </QuerySection>
        </span>
      </SummaryLine>
    );
  return (
    <SummaryLine label={slot.title}>
      <Popover>
        <PopoverTrigger
          data-signal={slot.id}
          className="inline-flex min-w-0 items-center gap-1 rounded-sm text-link outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring data-popup-open:underline"
        >
          <span className="min-w-0 truncate">
            {slot.kind === "report" ? (
              <ReportFigure id={id} slot={slot} slots={reportSlots} />
            ) : (
              <RecordsFigure entity={entity} id={id} slot={slot} />
            )}
          </span>
          <CaretDownIcon aria-hidden className="size-3 shrink-0" />
        </PopoverTrigger>
        <PopoverContent
          align="end"
          className="max-h-[min(32rem,var(--available-height))] w-[min(26rem,calc(100vw-1rem))] overflow-y-auto"
        >
          <SummarySlotBody
            entity={entity}
            id={id}
            slot={slot}
            reportSlots={reportSlots}
          />
        </PopoverContent>
      </Popover>
    </SummaryLine>
  );
}

/** Moves focus to the first Needs you item in the record's checklist. */
function focusFirstNeed(from: HTMLElement) {
  const item = from
    .closest("[data-record-workspace]")
    ?.querySelector<HTMLElement>("[data-needs-item]");
  if (!item) return;
  item.scrollIntoView({ block: "nearest" });
  (item.querySelector<HTMLElement>("a, button") ?? item).focus();
}

/**
 * The summary card: the record's declared key figures, the first as a tinted
 * hero and the rest as label and value lines (the declared lines, then the
 * chart, report and record cells), one "Resolve N items" button while
 * something waits on the member, and the step to the neighbouring record of
 * the list the member came from. `compact` (the inspector) is one line of
 * figures. Absent when the record has none of these.
 */
export function RecordSummary<E extends GenericDetailEntity>({
  entity,
  record,
  compact = false,
}: {
  entity: E;
  record: DetailRecordOf<E>;
  compact?: boolean;
}) {
  const queryClient = useQueryClient();
  const needs = useNeedsYou(entity, record);
  const lines = headerLinesOf(queryClient, entity, record);
  const slots = signalSlots(queryClient, entity, record).filter(
    (slot): slot is SignalSlot => slot.kind !== "fields",
  );
  const reportSlots = slots.flatMap((slot) =>
    slot.kind === "report" ? [slot.slot] : [],
  );
  const sequence = useRecordSequence(entity, record.id);
  const singular = entityMetadata(
    queryClient,
    entity,
  ).summary.singular.toLocaleLowerCase();
  if (
    lines.length === 0 &&
    slots.length === 0 &&
    needs.count === 0 &&
    !(sequence && !compact)
  )
    return null;
  const signal = (slot: SignalSlot) => (
    <SignalLine
      key={slot.id}
      entity={entity}
      id={record.id}
      slot={slot}
      reportSlots={reportSlots}
    />
  );
  if (compact)
    return (
      <section
        aria-label="Summary"
        data-record-summary
        className="record-card text-sm"
      >
        <dl className="grid grid-cols-1 gap-x-4">
          {lines.map((line) => (
            <SummaryLine
              key={line.label}
              label={line.label}
              figure={line.figure}
            >
              {line.value}
            </SummaryLine>
          ))}
          {slots.map(signal)}
        </dl>
      </section>
    );
  // The hero is a figure: the first declared line, else the first chart.
  const [heroLine, ...restLines] = lines;
  const heroSlot = heroLine
    ? undefined
    : slots.find(
        (slot): slot is Extract<SignalSlot, { kind: "chart" }> =>
          slot.kind === "chart",
      );
  const restSlots = slots.filter((slot) => slot !== heroSlot);
  return (
    <section
      aria-label="Summary"
      data-record-summary
      className="record-card overflow-hidden p-0! text-sm"
    >
      {heroLine || heroSlot ? (
        <div className="record-summary-hero">
          <p className="text-xs font-semibold text-muted-foreground">
            {heroLine?.label ?? heroSlot?.title}
          </p>
          {heroLine ? (
            <p
              className={cn(
                "text-3xl/9 font-semibold break-words text-foreground-strong",
                heroLine.figure && "tabular-nums",
              )}
            >
              {heroLine.value}
            </p>
          ) : heroSlot ? (
            <QuerySection
              title={heroSlot.title}
              resetKey={`${record.id}:${heroSlot.id}:hero`}
              fallback={<Skeleton className="h-12 w-full" />}
            >
              <MonthlySpendChart
                entity={entity}
                id={record.id}
                viewKey={heroSlot.viewKey}
                compact
              />
            </QuerySection>
          ) : null}
        </div>
      ) : null}
      <div className="space-y-3 px-4 py-3">
        {restLines.length + restSlots.length > 0 ? (
          <dl>
            {restLines.map((line) => (
              <SummaryLine
                key={line.label}
                label={line.label}
                figure={line.figure}
              >
                {line.value}
              </SummaryLine>
            ))}
            {restSlots.map(signal)}
          </dl>
        ) : null}
        {needs.count > 0 ? (
          <Button
            className="w-full"
            onClick={(event) => focusFirstNeed(event.currentTarget)}
          >
            Resolve {formatCount(needs.count)}{" "}
            {needs.count === 1 ? "item" : "items"}
          </Button>
        ) : null}
        {sequence ? (
          <div
            data-record-stepper
            className="flex items-center justify-between gap-2 border-t border-border pt-2 text-xs text-muted-foreground"
          >
            <span>In this list</span>
            <PrevNextButtons
              compact
              previous={{
                label: `Previous ${singular}`,
                shortcut: "[",
                disabled: !sequence.previous,
                onClick: () => sequence.go(-1),
              }}
              next={{
                label: `Next ${singular}`,
                shortcut: "]",
                disabled: !sequence.next,
                onClick: () => sequence.go(1),
              }}
            >
              <span className="font-mono tabular-nums">
                {formatCount(sequence.index + 1)} /{" "}
                {formatCount(sequence.total)}
              </span>
            </PrevNextButtons>
          </div>
        ) : null}
      </div>
    </section>
  );
}

const needsMark = (failed: boolean) =>
  failed ? (
    <StateMark kind="failed" />
  ) : (
    <StateMark kind="needs" className="size-1.5 rounded-full bg-needs" />
  );

/** One open item: its number key, its mark, what waits and its action. */
function NeedsItem({
  index,
  mark,
  id,
  children,
}: {
  index: number;
  mark: ReactNode;
  id?: string;
  children: ReactNode;
}) {
  return (
    <li
      id={id}
      data-needs-item
      // The page's number keys land here when the item has no control.
      tabIndex={-1}
      className="flex min-w-0 items-baseline gap-2 rounded-sm py-1 outline-none focus-visible:ring-2 focus-visible:ring-ring [&_a]:text-link [&_a]:hover:underline"
    >
      <span className="inline-flex w-3 shrink-0 justify-center">{mark}</span>
      <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2">
        {children}
      </div>
      {index < 9 ? (
        <span
          aria-hidden
          className="shrink-0 font-mono text-xs text-muted-foreground tabular-nums"
        >
          {index + 1}
        </span>
      ) : null}
    </li>
  );
}

/** A check that asks nothing of the member: satisfied, accepted or unscored. */
function QuietCheck({ check, id }: { check: RecordQualityCheck; id?: string }) {
  const Icon =
    check.state === "satisfied"
      ? CheckIcon
      : check.state === "excepted"
        ? MinusCircleIcon
        : StateMarkNeeds;
  return (
    <li id={id} className="flex min-w-0 items-baseline gap-2 py-0.5">
      <Icon
        aria-hidden
        className={cn(
          "size-3 shrink-0 translate-y-0.5",
          check.state === "satisfied"
            ? "text-positive"
            : "text-muted-foreground",
        )}
      />
      <span className="min-w-0">
        {check.label}
        <span className="text-muted-foreground"> · {check.stateLabel}</span>
      </span>
    </li>
  );
}

const StateMarkNeeds = ({ className }: { className?: string }) => (
  <span aria-hidden className={cn("rounded-full border", className)} />
);

/**
 * The Needs you and quality card: a checklist with the open items first, each
 * with its own action or a link to its owning field or section (numbered for
 * the 1-9 keys), then every other applicable check behind "+N satisfied", and
 * a status line with the counts. Absent when nothing waits and the record has
 * no checks.
 */
export function RecordChecklist<E extends GenericDetailEntity>({
  entity,
  record,
}: {
  entity: E;
  record: DetailRecordOf<E>;
}) {
  const needs = useNeedsYou(entity, record);
  const assessment = useQualityAssessment();
  if (needs.count === 0 && !needs.error && !assessment) return null;
  const placed = new Set(assessment?.checks ?? []);
  const attention = new Set(needs.quality);
  // A check this surface places nowhere keeps its result here, at its anchor.
  const anchorOf = (check: RecordQualityCheck) =>
    placed.has(check) ? undefined : assessment?.anchor(check);
  const otherGaps = (assessment?.unresolved ?? []).filter(
    (check) => !attention.has(check),
  );
  const quiet = (assessment?.all ?? []).filter(
    (check) => check.state !== "gap",
  );
  const satisfied = quiet.filter((check) => check.state === "satisfied");
  const offset = needs.items.length + needs.rows.length;
  return (
    <section
      aria-label={assessment ? "Record quality" : "Needs you"}
      data-record-checklist
      className="record-card text-sm"
    >
      <h2 className="mb-2 flex items-baseline gap-2 text-sm/5 font-semibold text-foreground">
        {assessment ? "Record quality" : "Needs you"}
        {needs.count > 0 ? (
          <span className="font-mono text-xs font-normal text-muted-foreground tabular-nums">
            {formatCount(needs.count)} open
          </span>
        ) : null}
      </h2>
      {needs.error ? (
        <ErrorDisplay error={needs.error} title="Needs you" />
      ) : null}
      {needs.count > 0 ? (
        <ul aria-label="Needs you" className="min-w-0">
          {needs.items.map((item, index) => {
            const target = entitySchema.safeParse(item.entity);
            return (
              <NeedsItem
                key={`${item.entity}:${item.id}:${item.title}`}
                index={index}
                mark={needsMark(needs.itemsFailed)}
              >
                {target.success &&
                item.id &&
                isBrowserRoutedEntity(target.data) ? (
                  <Link
                    to={entities[target.data].routes.detail}
                    params={entityDetailParams(item.id)}
                    className="min-w-0"
                  >
                    {item.title}
                  </Link>
                ) : (
                  <span className="min-w-0">{item.title}</span>
                )}
                {item.subtitle ? (
                  <span className="min-w-0 text-xs text-muted-foreground">
                    {item.subtitle}
                  </span>
                ) : null}
                {item.trailing ? (
                  <span className="ml-auto shrink-0 font-mono text-muted-foreground tabular-nums">
                    {item.trailing}
                  </span>
                ) : null}
              </NeedsItem>
            );
          })}
          {needs.rows.map((row, index) => (
            <NeedsItem
              key={row.key}
              index={needs.items.length + index}
              mark={needsMark(false)}
            >
              <RecordWorkQueueRow row={row} inline />
            </NeedsItem>
          ))}
          {needs.quality.map((check, index) => (
            <NeedsItem
              key={check.check}
              id={anchorOf(check)}
              index={offset + index}
              mark={needsMark(check.kind === "defect")}
            >
              <QualityIssueLink
                check={check}
                anchor={assessment?.anchor(check) ?? ""}
                className="min-w-0"
              />
              <span className="text-xs text-muted-foreground">
                {check.stateLabel}
              </span>
              {anchorOf(check) && assessment ? (
                <WhyValue
                  entity={assessment.entity}
                  id={assessment.id}
                  field="dataQuality"
                  label={check.label}
                  resolution={assessment.query.data?.envelope}
                />
              ) : null}
            </NeedsItem>
          ))}
        </ul>
      ) : null}
      {otherGaps.length > 0 ? (
        <ul aria-label="Other open checks" className="min-w-0 text-xs">
          {otherGaps.map((check) => (
            <QuietCheck key={check.check} check={check} id={anchorOf(check)} />
          ))}
        </ul>
      ) : null}
      {quiet.length > 0 ? (
        <details className="group/quiet mt-1 text-xs">
          <summary className="w-fit cursor-pointer list-none rounded-sm py-1 text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring max-md:min-h-11 [&::-webkit-details-marker]:hidden">
            <span aria-hidden className="mr-1 inline-block w-3">
              +
            </span>
            {satisfied.length === quiet.length
              ? `${formatCount(quiet.length)} satisfied`
              : `${formatCount(quiet.length)} satisfied or accepted`}
          </summary>
          <ul className="min-w-0">
            {quiet.map((check) => (
              <QuietCheck
                key={check.check}
                check={check}
                id={anchorOf(check)}
              />
            ))}
          </ul>
        </details>
      ) : null}
      {assessment ? (
        <div className="mt-2 border-t border-hairline-soft pt-2">
          <QualityStatusLine />
        </div>
      ) : null}
    </section>
  );
}
