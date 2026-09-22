import type { AuditLogListOut } from "@cubby/schemas/audit";
import { entityFieldModels } from "@cubby/schemas/entity-fields";
import { entitySummary } from "@cubby/schemas/entity-summary";
import type {
  EntityTimelineEvent,
  EntityTimelineGroup,
  EntityTimelineOrder,
  EntityTimelineOut,
  EntityTimelineRow,
} from "@cubby/schemas/entity-timeline";
import { z } from "zod";

import type {
  ParsedEntityTimelineInputByEntity,
  TimelineEntity,
} from "~/entities/generated/entity-timelines.gen";
import { householdDateTime, householdLocalDate } from "~/lib/household-date";
import { executeEntity } from "~/server/entity-kernel";
import type { EntityKernelContext } from "~/server/entity-kernel/adapter";
import { getAuditLog } from "~/server/repo/audit-log";
import { resolveLiveShortcodes } from "~/server/repo/shortcode-resolver";

/** Audit entries read for the page's records, newest first. */
const TIMELINE_AUDIT_CAP = 1000;
const ID_GET_CONCURRENCY = 25;

const timelineRowSchema = z
  .object({
    id: z.string().min(1),
    displayImages: z
      .array(z.object({ url: z.string() }).loose())
      .optional()
      .default([]),
  })
  .loose();
type TimelineRecord = z.output<typeof timelineRowSchema>;

type TimelineWindow =
  ParsedEntityTimelineInputByEntity[TimelineEntity]["window"];
type DatedEvent = { date: string; event: EntityTimelineEvent };
/** The compiled `list.timeline.lifecycle` shape: `start` is an ordered
 * fallback list (first non-null key starts the interval). Structural so a
 * test can hand in a synthetic lifecycle. */
type Lifecycle = {
  readonly start: readonly string[];
  readonly milestones: readonly string[];
  readonly end: string | null;
};

const AUDIT_ACTION_LABEL = {
  create: "Created",
  update: "Updated",
  delete: "Deleted",
} as const;

/** A stored `YYYY-MM-DD`, an ISO timestamp string, or a `Date`; anything else is not dated. */
const datedValue = z.union([
  z.date(),
  z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
  z.iso.datetime({ offset: true }).transform((value) => new Date(value)),
]);
const plainDateOf = (value: unknown): string | null => {
  const parsed = datedValue.safeParse(value);
  if (!parsed.success) return null;
  return parsed.data instanceof Date
    ? householdLocalDate(parsed.data)
    : parsed.data;
};

const inWindow = (date: string, window: TimelineWindow) =>
  (window.from === undefined || date >= window.from) &&
  (window.to === undefined || date <= window.to);

const recordTitle = (entity: TimelineEntity, record: TimelineRecord) =>
  z
    .string()
    .min(1)
    .catch(record.id)
    .parse(record[entitySummary[entity].titleField]);

const fieldLabel = (entity: TimelineEntity, key: string) =>
  entityFieldModels[entity].fields.find((field) => field.key === key)?.label ??
  key;

const recordLink = (entity: TimelineEntity, record: TimelineRecord) => ({
  entity,
  id: record.id,
});

/**
 * One page of the records in scope. The list read is `createdAt` in the
 * window's order with the list scaffold's id tie-break, so page 1 holds the
 * records the chosen order shows first and pages are stable; `window.ids`
 * pages in the order the ids were given.
 */
async function loadRecords(
  context: EntityKernelContext,
  input: ParsedEntityTimelineInputByEntity[TimelineEntity],
): Promise<{ records: TimelineRecord[]; totalCount: number }> {
  const { entity, filters, window, pagination } = input;
  if (window.ids) {
    // A detail page mounts with one id; a batched `get` per id is bounded by
    // the window schema (≤500) and never scans the list.
    const start = pagination.pageIndex * pagination.pageSize;
    const pageIds = window.ids.slice(start, start + pagination.pageSize);
    const records: TimelineRecord[] = [];
    for (let at = 0; at < pageIds.length; at += ID_GET_CONCURRENCY) {
      const results = await Promise.all(
        pageIds.slice(at, at + ID_GET_CONCURRENCY).map((id) =>
          executeEntity(context, {
            action: "get",
            entity,
            id,
            missing: "null",
          }),
        ),
      );
      for (const result of results) {
        if (result.action !== "get")
          throw new Error("Entity kernel returned the wrong action");
        if (result.item !== null)
          records.push(timelineRowSchema.parse(result.item));
      }
    }
    return { records, totalCount: window.ids.length };
  }
  const result = await executeEntity(context, {
    action: "list",
    entity,
    filters,
    sort: [{ orderBy: "createdAt", direction: window.order }],
    pagination,
  });
  if (result.action !== "list")
    throw new Error("Entity kernel returned the wrong action");
  return {
    records: result.items.map((item) => timelineRowSchema.parse(item)),
    totalCount: result.meta.totalCount,
  };
}

/** The audit window for the cohort; `createdAt` bounds are the household day's edges. */
const loadAudit = async (
  context: EntityKernelContext,
  entity: TimelineEntity,
  uuids: readonly string[],
  window: TimelineWindow,
): Promise<AuditLogListOut> => {
  if (uuids.length === 0) return { entries: [] };
  const params: Parameters<typeof getAuditLog>[1] = {
    entityType: entity,
    entityIds: uuids,
    limit: TIMELINE_AUDIT_CAP,
  };
  if (window.from)
    params.createdAtFrom = householdDateTime(window.from).toISOString();
  if (window.to)
    params.createdAtTo = new Date(
      householdDateTime(window.to, 24 * 60).getTime() - 1,
    ).toISOString();
  return getAuditLog(context.readDb, params);
};

const auditEvents = (
  entity: TimelineEntity,
  entries: AuditLogListOut["entries"],
  recordById: ReadonlyMap<string, TimelineRecord>,
): DatedEvent[] =>
  entries.flatMap((entry) => {
    const record = entry.entityId ? recordById.get(entry.entityId) : undefined;
    if (!record) return [];
    const changed = Object.keys(entry.changes ?? {});
    const detail =
      entry.action === "update" && changed.length > 0
        ? `${AUDIT_ACTION_LABEL.update} ${changed.map((key) => fieldLabel(entity, key)).join(", ")}`
        : AUDIT_ACTION_LABEL[entry.action];
    return [
      {
        date: householdLocalDate(entry.createdAt),
        event: {
          id: `audit:${entry.entryKey}`,
          kind: `audit:${entry.action}`,
          label: recordTitle(entity, record),
          detail,
          link: recordLink(entity, record),
        },
      },
    ];
  });

const fieldEvents = (
  entity: TimelineEntity,
  records: readonly TimelineRecord[],
  keys: readonly string[],
  window: TimelineWindow,
): DatedEvent[] =>
  records.flatMap((record) =>
    keys.flatMap((key) => {
      const date = plainDateOf(record[key]);
      if (date === null || !inWindow(date, window)) return [];
      return [
        {
          date,
          event: {
            id: `field:${record.id}:${key}`,
            kind: `field:${key}`,
            label: recordTitle(entity, record),
            detail: fieldLabel(entity, key),
            link: recordLink(entity, record),
          },
        },
      ];
    }),
  );

const groupByDate = (
  events: readonly DatedEvent[],
  order: EntityTimelineOrder,
): EntityTimelineGroup[] => {
  const byDate = new Map<string, EntityTimelineEvent[]>();
  for (const { date, event } of events) {
    const bucket = byDate.get(date);
    if (bucket) bucket.push(event);
    else byDate.set(date, [event]);
  }
  return [...byDate]
    .sort(([left], [right]) =>
      order === "asc" ? left.localeCompare(right) : right.localeCompare(left),
    )
    .map(([date, dated]) => ({
      key: date,
      date,
      events: dated.sort((left, right) =>
        left.label.localeCompare(right.label),
      ),
    }));
};

const lifecycleKeysOf = (lifecycle: Lifecycle): string[] => [
  ...lifecycle.start,
  ...lifecycle.milestones,
  ...(lifecycle.end ? [lifecycle.end] : []),
];

/**
 * `lifecycle.start` is an ordered fallback: the first key with a value wins.
 * `confident` is false once a fallback key (not the first) supplied it, so
 * the UI can mark an inferred interval start (e.g. a nursery-bought planting
 * whose interval starts at `transplantedOn` instead of `sowedOn`).
 */
const lifecycleStartOf = (
  record: TimelineRecord,
  lifecycle: Lifecycle,
): { date: string; confident: boolean } | null => {
  for (const [index, key] of lifecycle.start.entries()) {
    const date = plainDateOf(record[key]);
    if (date !== null) return { date, confident: index === 0 };
  }
  return null;
};

export const lifecycleRows = (
  entity: TimelineEntity,
  records: readonly TimelineRecord[],
  lifecycle: Lifecycle,
  window: TimelineWindow,
): EntityTimelineRow[] =>
  records.flatMap((record) => {
    const start = lifecycleStartOf(record, lifecycle);
    const end = lifecycle.end ? plainDateOf(record[lifecycle.end]) : null;
    const markers = lifecycleKeysOf(lifecycle).flatMap((key) => {
      const date = plainDateOf(record[key]);
      return date === null || !inWindow(date, window)
        ? []
        : [{ date, kind: `field:${key}`, link: recordLink(entity, record) }];
    });
    if (start === null && markers.length === 0) return [];
    return [
      {
        id: record.id,
        name: recordTitle(entity, record),
        link: recordLink(entity, record),
        imageUrl: record.displayImages[0]?.url ?? null,
        intervals:
          start === null
            ? []
            : [{ start: start.date, end, confident: start.confident }],
        markers,
      },
    ];
  });

/**
 * The extent stays inside the window: an interval that spans it counts only
 * for the part inside, and an open interval runs to today.
 */
const extentOf = (
  events: readonly DatedEvent[],
  rows: readonly EntityTimelineRow[],
  window: TimelineWindow,
): EntityTimelineOut["extent"] => {
  const clamp = (date: string) =>
    window.from !== undefined && date < window.from
      ? window.from
      : window.to !== undefined && date > window.to
        ? window.to
        : date;
  const today = householdLocalDate();
  const dates = [
    ...events.map(({ date }) => date),
    ...rows.flatMap((row) => [
      ...row.intervals.flatMap((interval) => {
        const end = interval.end ?? today;
        return (window.from !== undefined && end < window.from) ||
          (window.to !== undefined && interval.start > window.to)
          ? []
          : [clamp(interval.start), clamp(end)];
      }),
      ...row.markers.map((marker) => marker.date),
    ]),
  ].sort();
  const from = dates[0];
  const to = dates[dates.length - 1];
  return from === undefined || to === undefined ? undefined : { from, to };
};

/**
 * The shared `resources.<entity>.timeline`: audit-log entries for every
 * record in scope plus `field:<key>` events for the declared date fields,
 * grouped by household calendar date; lifecycle rows when the entity
 * declares `list.timeline.lifecycle`.
 */
export async function defaultTimeline(
  context: EntityKernelContext,
  input: ParsedEntityTimelineInputByEntity[TimelineEntity],
): Promise<EntityTimelineOut> {
  return (await defaultTimelinePage(context, input)).out;
}

/** {@link defaultTimeline} plus the live ids of the page's records, for a
 * custom implementation that decorates the same page. */
export async function defaultTimelinePage(
  context: EntityKernelContext,
  input: ParsedEntityTimelineInputByEntity[TimelineEntity],
): Promise<{ out: EntityTimelineOut; recordIds: string[] }> {
  const { entity, window, pagination } = input;
  const declared = entitySummary[entity].list.timeline;
  const lifecycle = declared?.lifecycle ?? null;
  const dateKeys =
    declared && declared.fields.length > 0
      ? declared.fields
      : lifecycle
        ? lifecycleKeysOf(lifecycle)
        : [];

  const { records, totalCount } = await loadRecords(context, input);
  const recordById = new Map(records.map((record) => [record.id, record]));
  const paged = totalCount > records.length;
  const notes: string[] = [];

  const uuidByCode = await resolveLiveShortcodes(
    context.readDb,
    records.map((record) => record.id),
    entity,
  );
  const audit = await loadAudit(
    context,
    entity,
    [...uuidByCode.values()],
    window,
  );
  if (audit.nextCursor)
    notes.push(
      `Only the newest ${TIMELINE_AUDIT_CAP} audit entries are shown; narrow the date window to see older changes.`,
    );

  const events = [
    ...auditEvents(entity, audit.entries, recordById),
    ...fieldEvents(entity, records, dateKeys, window),
  ];
  const rows = lifecycle
    ? lifecycleRows(entity, records, lifecycle, window)
    : undefined;

  const out: EntityTimelineOut = {
    groups: groupByDate(events, window.order),
    stats: [
      {
        key: "records",
        label: "Records",
        value: paged
          ? `${records.length} of ${totalCount}`
          : String(totalCount),
      },
      { key: "events", label: "Events", value: String(events.length) },
      {
        key: "audit",
        label: "Audit entries",
        value: String(audit.entries.length),
      },
    ],
    notes,
    meta: { totalCount, ...pagination },
  };
  if (rows) out.rows = rows;
  const extent = extentOf(events, rows ?? [], window);
  if (extent) out.extent = extent;
  return { out, recordIds: [...uuidByCode.values()] };
}
