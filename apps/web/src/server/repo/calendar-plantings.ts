import type {
  CalendarItem,
  CalendarPlantingMilestone,
  CalendarRangeInput,
} from "@cubby/schemas/calendar";
import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import { addDays } from "date-fns";
import type { AnyColumn } from "drizzle-orm";
import { and, eq, gte, isNotNull, lte, or } from "drizzle-orm";

import { formatPlainDate, parsePlainDate } from "~/lib/plain-date";
import type { Database } from "~/server/db";
import { location, plant, planting } from "~/server/db/schema";
import { plantingDisplayName } from "~/server/repo/garden";

import { getDb, notDeleted } from "./database-helpers";

const shiftPlainDate = (value: string, amount: number) =>
  formatPlainDate(addDays(parsePlainDate(value), amount));

/** The planting lifecycle's milestone date columns, in the order they occur.
 * Shared by the "any milestone falls in range" read predicate and by
 * `mapPlantingItems`'s per-milestone emission. */
const MILESTONE_COLUMNS = {
  sowed: planting.sowedOn,
  transplanted: planting.transplantedOn,
  finished: planting.finishedOn,
} as const satisfies Record<CalendarPlantingMilestone, AnyColumn>;

// SAFETY: `Object.keys` only widens to `string[]` — the keys are exactly
// `MILESTONE_COLUMNS`'s own, which the `satisfies` above already ties to
// `CalendarPlantingMilestone`.
const MILESTONES = Object.keys(
  MILESTONE_COLUMNS,
) as CalendarPlantingMilestone[];

/**
 * One bounded read of every planting with at least one lifecycle milestone
 * (`sowedOn`/`transplantedOn`/`finishedOn`) inside the queried range. A row
 * can carry more than one in-range milestone (e.g. sowed AND
 * transplanted this month) — `mapPlantingItems` is what turns each populated,
 * in-range date into its own item.
 */
export const loadCalendarPlantings = (
  db: Database,
  input: CalendarRangeInput,
  endInclusive: string,
) => {
  if (input.kinds && !input.kinds.includes("planting")) {
    return Promise.resolve([]);
  }
  return getDb(db)
    .select({
      shortcode: planting.shortcode,
      plantName: plant.name,
      gardenGuideKey: plant.gardenGuideKey,
      locationName: location.name,
      plannedWindow: planting.plannedWindow,
      sowedOn: planting.sowedOn,
      transplantedOn: planting.transplantedOn,
      finishedOn: planting.finishedOn,
    })
    .from(planting)
    .innerJoin(plant, eq(planting.plantId, plant.id))
    .leftJoin(location, eq(planting.locationId, location.id))
    .where(
      and(
        notDeleted(planting),
        or(
          ...MILESTONES.map((milestone) =>
            and(
              isNotNull(MILESTONE_COLUMNS[milestone]),
              gte(MILESTONE_COLUMNS[milestone], input.startDate),
              lte(MILESTONE_COLUMNS[milestone], endInclusive),
            ),
          ),
        ),
      ),
    );
};

/** Row shape `mapPlantingItems` maps from — kept structural (not tied to the
 * query builder's inferred type) so it doubles as a pure unit-test fixture
 * shape with no database dependency. */
export interface CalendarPlantingRow {
  shortcode: string;
  plantName: string;
  gardenGuideKey: string | null;
  locationName: string | null;
  plannedWindow: string | null;
  sowedOn: string | null;
  transplantedOn: string | null;
  finishedOn: string | null;
}

const MILESTONE_DATE = {
  sowed: "sowedOn",
  transplanted: "transplantedOn",
  finished: "finishedOn",
} satisfies Record<CalendarPlantingMilestone, keyof CalendarPlantingRow>;

/**
 * One `CalendarItem` per populated, in-range milestone — a planting sowed and
 * transplanted within the same queried range emits two items. Re-checks each
 * milestone against `input`'s range independently of how the row was
 * fetched, so a milestone outside the range (even on an in-range row) is
 * skipped rather than emitted.
 */
export const mapPlantingItems = (
  rows: readonly CalendarPlantingRow[],
  input: Pick<CalendarRangeInput, "startDate" | "endDateExclusive">,
): CalendarItem[] =>
  rows.flatMap((row) =>
    MILESTONES.flatMap((milestone) => {
      const date = row[MILESTONE_DATE[milestone]];
      if (!date || date < input.startDate || date >= input.endDateExclusive) {
        return [];
      }
      return [
        {
          kind: "planting" as const,
          id: parseShortcodeFor("planting", row.shortcode),
          milestone,
          title: plantingDisplayName({
            name: row.plantName,
            gardenGuideKey: row.gardenGuideKey,
          }),
          locationName: row.locationName,
          plannedWindow: row.plannedWindow,
          startDate: date,
          endDateExclusive: shiftPlainDate(date, 1),
          interaction: "read-only" as const,
        },
      ];
    }),
  );
