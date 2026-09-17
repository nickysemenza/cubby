import type { EntityTimelineRow } from "@cubby/schemas/entity-timeline";
import { parseShortcodeFor, type PlantingId } from "@cubby/schemas/identifiers";
import { and, eq, inArray } from "drizzle-orm";

import type { ParsedEntityTimelineInputByEntity } from "~/entities/generated/entity-timelines.gen";
import { householdLocalDate } from "~/lib/household-date";
import { ingredient, planting } from "~/server/db/schema";
import type { EntityKernelContext } from "~/server/entity-kernel/adapter";
import type { EntityTimelineImplementation } from "~/server/entity-timeline/contracts";
import {
  defaultTimeline,
  TIMELINE_ROW_CAP,
} from "~/server/entity-timeline/default-timeline";
import {
  guideSowMonthsFor,
  resolveGardenGuideKey,
} from "~/server/garden-guides/windows";
import { getDb, notDeleted } from "~/server/repo/database-helpers";
import { resolveLiveShortcodes } from "~/server/repo/shortcode-resolver";

import { plantingList } from ".";

const pad2 = (value: number) => String(value).padStart(2, "0");
const lastDayOfMonth = (year: number, month: number) =>
  new Date(Date.UTC(year, month, 0)).getUTCDate();

/**
 * The live planting ids `defaultTimeline` itself resolved for this request —
 * either a detail page's `window.ids`, or the same filtered/capped/sorted
 * list read it uses for the `window.ids`-less case (`TIMELINE_ROW_CAP`,
 * `createdAt desc`) — so the guide band below covers exactly the same cohort.
 */
const cohortPlantingIds = async (
  context: EntityKernelContext,
  input: ParsedEntityTimelineInputByEntity["planting"],
): Promise<PlantingId[]> => {
  if (input.window.ids) {
    const resolved = await resolveLiveShortcodes(
      context.readDb,
      input.window.ids,
      "planting",
    );
    return [...resolved.values()];
  }
  const { data } = await plantingList(
    context.readDb,
    input.filters,
    { pageIndex: 0, pageSize: TIMELINE_ROW_CAP },
    [{ orderBy: "createdAt", direction: "desc" }],
  );
  const resolved = await resolveLiveShortcodes(
    context.readDb,
    data.map((item) => item.id),
    "planting",
  );
  return [...resolved.values()];
};

/**
 * One extra lifecycle row per planting in the cohort, for the recommended
 * sow window (household microclimate, falling back to the regional one) in
 * the current year — only when the crop has a guide with a sow/direct-sow
 * window. `confident: false` since this is a recommendation, not a recorded
 * date.
 */
const guideSowRows = async (
  context: EntityKernelContext,
  plantingIds: readonly PlantingId[],
): Promise<EntityTimelineRow[]> => {
  if (plantingIds.length === 0) return [];
  const rows = await getDb(context.readDb)
    .select({
      shortcode: planting.shortcode,
      ingredientName: ingredient.name,
      gardenGuideKey: ingredient.gardenGuideKey,
    })
    .from(planting)
    .innerJoin(ingredient, eq(planting.ingredientId, ingredient.id))
    .where(and(inArray(planting.id, plantingIds), notDeleted(planting)));

  const year = Number(householdLocalDate().slice(0, 4));
  const out: EntityTimelineRow[] = [];
  for (const row of rows) {
    const months = guideSowMonthsFor(resolveGardenGuideKey(row.gardenGuideKey));
    if (!months || months.length === 0) continue;
    const min = Math.min(...months);
    const max = Math.max(...months);
    out.push({
      id: `guide-sow:${parseShortcodeFor("planting", row.shortcode)}`,
      name: `Recommended sow · ${row.ingredientName}`,
      imageUrl: null,
      intervals: [
        {
          start: `${year}-${pad2(min)}-01`,
          end: `${year}-${pad2(max)}-${pad2(lastDayOfMonth(year, max))}`,
          confident: false,
        },
      ],
      markers: [],
    });
  }
  return out;
};

/** `resources.planting.timeline`, bound through `ports.timeline`: wraps the
 * shared default (audit events + the sowed/transplanted/finished lifecycle
 * rows) and appends one recommended-sow-window row per planting in scope. */
export const plantingTimeline: EntityTimelineImplementation<
  "planting"
> = async (context, input) => {
  const base = await defaultTimeline(context, input);
  const plantingIds = await cohortPlantingIds(context, input);
  const guideRows = await guideSowRows(context, plantingIds);
  if (guideRows.length === 0) return base;
  return { ...base, rows: [...(base.rows ?? []), ...guideRows] };
};
