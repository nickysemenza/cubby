import { entitySchema } from "@cubby/schemas/entity";
import type { CompiledEntityPresentation } from "@cubby/schemas/entity-definitions/definition";
import { displayItems } from "@cubby/schemas/entity-definitions/label-field";
import type { DetailSummarySlot } from "@cubby/schemas/entity-detail-summary";
import type { EntityFieldModel } from "@cubby/schemas/entity-fields";
import { CaretDownIcon } from "@phosphor-icons/react/dist/csr/CaretDown";
import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { readRecordState } from "~/entity/display/list-renderers/generic-state";
import {
  entities,
  entityDetailParams,
  isBrowserRoutedEntity,
} from "~/entity/entities";
import { useMachinery } from "~/entity/machinery/record-machinery";
import { entityMetadata } from "~/entity/metadata";
import {
  RecordWorkQueueRow,
  useRecordWorkQueue,
} from "~/entity/work-queue/record-work-queue";
import { formatCount } from "~/lib/number-format";
import { ErrorDisplay } from "~/ui/feedback/error-display";
import { QuerySection } from "~/ui/feedback/query-section";
import { PrevNextButtons } from "~/ui/navigation/prev-next-buttons";
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
import { QualityIssueLink, useQualityAttention } from "./record-quality";
import { useRecordSequence } from "./record-sequence";
import { MonthlySpendChart } from "./spend-chart";

type Field = EntityFieldModel["fields"][number];

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

const needsMark = (failed: boolean) =>
  failed ? (
    <StateMark kind="failed" />
  ) : (
    <StateMark kind="needs" className="size-1.5 rounded-full bg-needs" />
  );

/** One Needs you item: its mark, what waits, and the action that settles it. */
function NeedsChip({
  index,
  failed,
  children,
}: {
  index: number;
  failed: boolean;
  children: ReactNode;
}) {
  return (
    <li
      data-needs-item
      className="flex min-h-(--record-pill-height) max-w-full min-w-0 items-center gap-1.5 border border-border px-1.5 text-xs [&_a]:text-link [&_a]:hover:underline"
    >
      {index < 9 ? (
        <span
          aria-hidden
          className="font-mono text-muted-foreground tabular-nums"
        >
          {index + 1}
        </span>
      ) : null}
      {needsMark(failed)}
      {children}
    </li>
  );
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
  const quality = useQualityAttention().filter(
    ({ check }) => !named.has(check.check),
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

/** A signals-bar cell: a quiet label, its figure, and the full cell behind it. */
function SignalCell({
  entity,
  id,
  slot,
  reportSlots,
}: {
  entity: GenericDetailEntity;
  id: string;
  slot: Exclude<DetailSummarySlot, { kind: "fields" }>;
  reportSlots: Parameters<typeof SummarySlotBody>[0]["reportSlots"];
}) {
  if (slot.kind === "chart")
    return (
      <div
        data-signal={slot.id}
        className="flex h-8 min-w-0 items-center gap-2 border-l border-border px-3"
      >
        <span className="text-muted-foreground">{slot.title}</span>
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
      </div>
    );
  return (
    <Popover>
      <PopoverTrigger
        data-signal={slot.id}
        className="flex h-8 min-w-0 items-center gap-1 border-l border-border px-3 text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset data-popup-open:bg-row-current data-popup-open:text-foreground"
      >
        <span className="truncate">{slot.title}</span>
        <CaretDownIcon aria-hidden className="size-3 shrink-0" />
      </PopoverTrigger>
      <PopoverContent
        align="start"
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
  );
}

/**
 * The bar pinned above a record's sections: the Needs you count, the declared
 * summary cells as figures, and the step to the neighbouring record of the
 * list the member came from. Its second line names each Needs you item beside
 * its own action, and is absent when nothing waits.
 */
export function RecordSignals<E extends GenericDetailEntity>({
  entity,
  record,
}: {
  entity: E;
  record: DetailRecordOf<E>;
}) {
  const queryClient = useQueryClient();
  const needs = useNeedsYou(entity, record);
  const slots = signalSlots(queryClient, entity, record);
  const reportSlots = slots.flatMap((slot) =>
    slot.kind === "report" ? [slot.slot] : [],
  );
  const sequence = useRecordSequence(entity, record.id);
  const singular = entityMetadata(
    queryClient,
    entity,
  ).summary.singular.toLocaleLowerCase();
  if (needs.count === 0 && !needs.error && slots.length === 0 && !sequence)
    return null;
  return (
    <div data-record-signals className="text-sm">
      <div className="flex min-h-8 min-w-0 items-stretch">
        <div className="flex min-w-0 flex-1 flex-wrap items-stretch [&>:first-child]:border-l-0">
          {needs.count > 0 ? (
            <p
              data-testid="needs-you"
              className="flex h-8 items-center px-3 max-md:px-2"
            >
              <span className="inline-flex h-(--pill-height) items-center gap-1.5 rounded-sm bg-needs px-1.5 text-xs font-semibold text-needs-foreground">
                Needs you
                <span className="font-mono tabular-nums">
                  {formatCount(needs.count)}
                </span>
              </span>
            </p>
          ) : null}
          {slots.map((slot) =>
            slot.kind === "fields" ? null : (
              <SignalCell
                key={slot.id}
                entity={entity}
                id={record.id}
                slot={slot}
                reportSlots={reportSlots}
              />
            ),
          )}
        </div>
        {sequence ? (
          <div
            data-record-stepper
            className="flex shrink-0 items-center gap-1.5 border-l border-border px-2 text-xs text-muted-foreground"
          >
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
      {needs.error ? (
        <div className="border-t border-border px-3 py-1">
          <ErrorDisplay error={needs.error} title="Needs you" />
        </div>
      ) : null}
      {needs.count > 0 ? (
        <ul
          aria-label="Needs you"
          className="flex min-w-0 flex-wrap items-center gap-1.5 border-t border-border px-3 py-0.5 max-md:px-2"
        >
          {needs.items.map((item, index) => {
            const target = entitySchema.safeParse(item.entity);
            return (
              <NeedsChip
                key={`${item.entity}:${item.id}:${item.title}`}
                index={index}
                failed={needs.itemsFailed}
              >
                {target.success &&
                item.id &&
                isBrowserRoutedEntity(target.data) ? (
                  <Link
                    to={entities[target.data].routes.detail}
                    params={entityDetailParams(item.id)}
                    className="min-w-0 truncate"
                  >
                    {item.title}
                  </Link>
                ) : (
                  <span className="min-w-0 truncate">{item.title}</span>
                )}
                {item.subtitle ? (
                  <span className="min-w-0 truncate text-muted-foreground">
                    {item.subtitle}
                  </span>
                ) : null}
                {item.trailing ? (
                  <span className="shrink-0 font-mono text-muted-foreground tabular-nums">
                    {item.trailing}
                  </span>
                ) : null}
              </NeedsChip>
            );
          })}
          {needs.rows.map((row, index) => (
            <NeedsChip
              key={row.key}
              index={needs.items.length + index}
              failed={false}
            >
              <RecordWorkQueueRow row={row} inline />
            </NeedsChip>
          ))}
          {needs.quality.map(({ check, anchor }, index) => (
            <NeedsChip
              key={check.check}
              index={needs.items.length + needs.rows.length + index}
              failed={check.kind === "defect"}
            >
              <QualityIssueLink
                check={check}
                anchor={anchor}
                className="min-w-0 truncate"
              />
              <span className="shrink-0 text-muted-foreground">
                {check.stateLabel}
              </span>
            </NeedsChip>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
