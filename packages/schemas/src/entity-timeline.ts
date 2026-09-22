import { z } from "zod";

import { plainDate } from "./base-entity";

/**
 * `resources.<entity>.timeline`: the entity's dated history over a list
 * scope. `filters` are the entity's own list filters (flattened onto the
 * query string), `ids` narrows to specific records (a detail page mounts the
 * timeline with `ids: [record.id]`), `from`/`to` bound the window, and the
 * input's `pagination` (beside the window) selects one page of records.
 */
export const entityTimelineOrder = z.enum(["asc", "desc"]);
export type EntityTimelineOrder = z.infer<typeof entityTimelineOrder>;

export const entityTimelineWindowFor = <Id extends z.ZodType<string>>(id: Id) =>
  z.object({
    ids: z.array(id).min(1).max(500).optional(),
    from: plainDate.optional(),
    to: plainDate.optional(),
    order: entityTimelineOrder.default("desc"),
  });
/** Timeline pages are bounded like list pages; a page is a set of records (rows). */
export const ENTITY_TIMELINE_MAX_PAGE_SIZE = 500;
export const ENTITY_TIMELINE_DEFAULT_PAGE_SIZE = 200;

/**
 * The entity-list kernel's `pagination` shape. Each implementation pages the
 * records its rows and events come from in a deterministic order, and
 * reports the full scope in `meta.totalCount`.
 */
export const entityTimelinePagination = z
  .object({
    pageIndex: z.number().int().min(0).default(0),
    pageSize: z
      .number()
      .int()
      .min(1)
      .max(ENTITY_TIMELINE_MAX_PAGE_SIZE)
      .default(ENTITY_TIMELINE_DEFAULT_PAGE_SIZE),
  })
  .prefault({});
export type EntityTimelinePagination = z.output<
  typeof entityTimelinePagination
>;

/** The window with unbranded ids; the generated per-entity inputs brand them. */
export const entityTimelineWindow = entityTimelineWindowFor(z.string().min(1));
export type EntityTimelineWindow = z.infer<typeof entityTimelineWindow>;

/** Where an event or row links to: an entity record, or a bare path. */
export const entityTimelineLink = z.object({
  entity: z.string().min(1),
  id: z.string().min(1),
});

export const entityTimelineEvent = z.object({
  id: z.string().min(1),
  /** `audit:<action>`, `field:<key>`, or a custom implementation's own kind. */
  kind: z.string().min(1),
  label: z.string().min(1),
  amount: z.number().nullable().optional(),
  link: entityTimelineLink.nullable().optional(),
  detail: z.string().nullable().optional(),
});
export type EntityTimelineEvent = z.infer<typeof entityTimelineEvent>;

export const entityTimelineGroup = z.object({
  key: z.string().min(1),
  date: plainDate.nullable(),
  label: z.string().nullable().optional(),
  link: entityTimelineLink.nullable().optional(),
  events: z.array(entityTimelineEvent),
});
export type EntityTimelineGroup = z.infer<typeof entityTimelineGroup>;

/** One record's lifecycle: intervals it was "live" plus dated markers. */
export const entityTimelineRow = z.object({
  id: z.string().min(1),
  name: z.string(),
  /** Navigation target when this row represents a record; synthetic rows may omit it. */
  link: entityTimelineLink.nullable().optional(),
  imageUrl: z.string().nullable().optional(),
  intervals: z.array(
    z.object({
      start: plainDate,
      end: plainDate.nullable().optional(),
      /** False when the interval's bounds are inferred rather than recorded. */
      confident: z.boolean(),
    }),
  ),
  markers: z.array(
    z.object({
      date: plainDate,
      kind: z.string().min(1),
      link: entityTimelineLink.nullable().optional(),
    }),
  ),
});
export type EntityTimelineRow = z.infer<typeof entityTimelineRow>;

export const entityTimelineStat = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  value: z.string(),
});

export const entityTimelineMeta = z.object({
  /** Records in scope across every page. */
  totalCount: z.number().int().nonnegative(),
  pageIndex: z.number().int().nonnegative(),
  pageSize: z.number().int().positive().max(ENTITY_TIMELINE_MAX_PAGE_SIZE),
});
export type EntityTimelineMeta = z.infer<typeof entityTimelineMeta>;

export const entityTimelineOut = z.object({
  groups: z.array(entityTimelineGroup),
  /** Present only when the entity declares `list.timeline.lifecycle` or a custom implementation supplies rows. */
  rows: z.array(entityTimelineRow).optional(),
  stats: z.array(entityTimelineStat),
  /** Human-readable caveats (truncation, inferred bounds). */
  notes: z.array(z.string()),
  extent: z.object({ from: plainDate, to: plainDate }).optional(),
  meta: entityTimelineMeta,
});
export type EntityTimelineOut = z.infer<typeof entityTimelineOut>;
