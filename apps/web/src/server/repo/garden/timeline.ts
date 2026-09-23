import type { EntityTimelineRow } from "@cubby/schemas/entity-timeline";
import { parseEntityId, parseShortcodeFor } from "@cubby/schemas/identifiers";
import { and, eq, inArray, ne } from "drizzle-orm";

import { householdLocalDate } from "~/lib/household-date";
import { plant, planting } from "~/server/db/schema";
import type { EntityKernelContext } from "~/server/entity-kernel/adapter";
import type { EntityTimelineImplementation } from "~/server/entity-timeline/contracts";
import { defaultTimelinePage } from "~/server/entity-timeline/default-timeline";
import {
  guideBandMonthsFor,
  resolveGardenGuideKey,
  plantDisplayName,
} from "~/server/garden-guides/windows";
import { getDb, notDeleted } from "~/server/repo/database-helpers";

const pad2 = (value: number) => String(value).padStart(2, "0");
const lastDayOfMonth = (year: number, month: number) =>
  new Date(Date.UTC(year, month, 0)).getUTCDate();

/**
 * One extra lifecycle row per planting in the cohort per guide method that
 * has a window — recommended sow and/or transplant (household microclimate,
 * falling back to the regional one) in the current year. A crop such as
 * tomato has a transplant window here but no sow window, so the transplant
 * band is the only one it gets. `confident: false` since this is a
 * recommendation, not a recorded date.
 */
const guideRows = async (
  context: EntityKernelContext,
  plantingIds: readonly string[],
): Promise<EntityTimelineRow[]> => {
  if (plantingIds.length === 0) return [];
  const rows = await getDb(context.readDb)
    .select({
      shortcode: planting.shortcode,
      plantName: plant.name,
      gardenGuideKey: plant.gardenGuideKey,
    })
    .from(planting)
    .innerJoin(plant, eq(planting.plantId, plant.id))
    .where(
      and(
        inArray(
          planting.id,
          plantingIds.map((id) => parseEntityId("planting", id)),
        ),
        notDeleted(planting),
        // A finished planting is done; recommending a future sow/transplant
        // window for it would be misleading.
        ne(planting.status, "finished"),
      ),
    );

  const year = Number(householdLocalDate().slice(0, 4));
  const out: EntityTimelineRow[] = [];
  for (const row of rows) {
    const bands = guideBandMonthsFor(resolveGardenGuideKey(row.gardenGuideKey));
    const id = parseShortcodeFor("planting", row.shortcode);
    for (const method of ["sow", "transplant"] as const) {
      const months = bands[method];
      if (!months || months.length === 0) continue;
      const min = Math.min(...months);
      const max = Math.max(...months);
      out.push({
        id: `guide-${method}:${id}`,
        name: `Recommended ${method} · ${plantDisplayName(row.plantName, row.gardenGuideKey)}`,
        // The synthetic id keeps sow and transplant rows independently stable;
        // navigation still belongs to the live planting record.
        link: { entity: "planting", id },
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
  }
  return out;
};

/** `resources.planting.timeline`, bound through `ports.timeline`: wraps the
 * shared default (audit events + the sowed/transplanted/finished lifecycle
 * rows) and appends the recommended sow/transplant rows for the plantings on
 * the same page, so the guide bands page with the default's records. */
export const plantingTimeline: EntityTimelineImplementation<
  "planting"
> = async (context, input) => {
  const { out: base, recordIds } = await defaultTimelinePage(context, input);
  const bands = await guideRows(context, recordIds);
  if (bands.length === 0) return base;
  return { ...base, rows: [...(base.rows ?? []), ...bands] };
};
