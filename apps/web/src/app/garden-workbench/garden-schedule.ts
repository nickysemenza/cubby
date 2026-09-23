import type { GardenGuideWindow } from "@cubby/schemas/garden-guide";
import { plantingGuides } from "@cubby/schemas/garden-guides";
import type { GardenCropKey } from "@cubby/schemas/garden-practice";
import { gardenCropLabel } from "@cubby/schemas/garden-practice";
import type { PlantingOut } from "@cubby/schemas/planting";

import type {
  ScheduleRow,
  ScheduleSegment,
  ScheduleWindow,
} from "~/app/_components/schedule/schedule-grid";

export const yearWindow = (year: number): ScheduleWindow => ({
  startDate: `${year}-01-01`,
  endDate: `${year}-12-31`,
});

const pad = (value: number) => String(value).padStart(2, "0");
const isoDate = (year: number, month: number, day: number) =>
  `${year}-${pad(month)}-${pad(day)}`;

const lastDay = (year: number, month: number) =>
  new Date(Date.UTC(year, month, 0)).getUTCDate();

const nextDay = (date: string) => {
  const parsed = new Date(`${date}T00:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() + 1);
  return parsed.toISOString().slice(0, 10);
};

const methodLabels = {
  sow: "Sow",
  "direct-sow": "Direct sow",
  transplant: "Transplant",
  root: "Plant roots",
  set: "Plant sets",
  tuber: "Plant tubers",
  rhizome: "Plant rhizomes",
  "bare-root": "Plant bare roots",
  unspecified: "Method unspecified",
} satisfies Record<GardenGuideWindow["method"], string>;

/** Keep each source's precision and disjoint month runs; never average sources. */
export function guideWindowSegments(
  window: GardenGuideWindow,
  year: number,
  id: string,
): ScheduleSegment[] {
  const spans = [...window.months]
    .sort((a, b) => a - b)
    .map((month) => ({
      start: isoDate(year, month, window.monthPart === "weeks-3-4" ? 16 : 1),
      end: isoDate(
        year,
        month,
        window.monthPart === "weeks-1-2" ? 15 : lastDay(year, month),
      ),
    }));
  const runs: Array<{ start: string; end: string }> = [];
  for (const span of spans) {
    const previous = runs.at(-1);
    if (previous && nextDay(previous.end) === span.start) {
      previous.end = span.end;
    } else {
      runs.push({ ...span });
    }
  }
  const precision = window.monthPart
    ? window.monthPart === "weeks-1-2"
      ? "first half of month"
      : "second half of month"
    : "whole month";
  return runs.map((run, index) => ({
    id: `${id}-${index}`,
    label: `${methodLabels[window.method]} · ${precision}${window.notes ? ` · ${window.notes}` : ""}`,
    startDate: run.start,
    endDate: run.end,
    variant: "reference",
  }));
}

const relevantClimate = (climate: GardenGuideWindow["microclimate"]) =>
  climate === "sunny" || climate === "bay-area" || climate === "unspecified";

export function guideScheduleRows(
  year: number,
  crop?: GardenCropKey,
): ScheduleRow[] {
  const guides = crop
    ? plantingGuides.guides.filter((guide) => guide.key === crop)
    : plantingGuides.guides;
  return guides.flatMap((guide) => {
    const windows = guide.windows.filter((window) =>
      relevantClimate(window.microclimate),
    );
    if (windows.length === 0) return [];
    const rows: ScheduleRow[] = [
      {
        id: `crop:${guide.key}`,
        name: guide.name,
        depth: 0,
        group: true,
        segments: [],
      },
    ];
    for (const [index, window] of windows.entries()) {
      const source = plantingGuides.sources.find(
        (candidate) => candidate.id === window.sourceId,
      );
      const id = `guide:${guide.key}:${window.sourceId}:${index}`;
      rows.push({
        id,
        name: source?.name ?? window.sourceId,
        depth: 1,
        meta: `${methodLabels[window.method]} · ${window.microclimate}${window.monthPart ? " · half-month precision" : " · month precision"}`,
        metaShort: methodLabels[window.method],
        segments: guideWindowSegments(window, year, id),
      });
    }
    return rows;
  });
}

const plantingSegments = (planting: PlantingOut): ScheduleSegment[] => {
  const segments: ScheduleSegment[] = [];
  if (planting.sowedOn) {
    segments.push({
      id: `${planting.id}:sowed`,
      label: `Sowed · ${planting.sowedOn}`,
      startDate: planting.sowedOn,
      variant: "milestone",
    });
  }
  if (planting.transplantedOn) {
    segments.push({
      id: `${planting.id}:transplanted`,
      label: `Transplanted · ${planting.transplantedOn}`,
      startDate: planting.transplantedOn,
      variant: "milestone",
    });
  }
  if (planting.expectedHarvestStart) {
    segments.push({
      id: `${planting.id}:harvest`,
      label: planting.expectedHarvest ?? "Expected harvest",
      startDate: planting.expectedHarvestStart,
      endDate: planting.expectedHarvestEnd ?? planting.expectedHarvestStart,
      variant: "range",
    });
  }
  if (planting.finishedOn) {
    segments.push({
      id: `${planting.id}:finished`,
      label: `Finished · ${planting.finishedOn}`,
      startDate: planting.finishedOn,
      variant: "milestone",
    });
  }
  return segments;
};

/** Current location is a grouping key, never a reconstructed location history. */
export function plantingScheduleRows(
  plantings: readonly PlantingOut[],
  year: number,
  guideKeyByPlant?: ReadonlyMap<string, GardenCropKey | null>,
): ScheduleRow[] {
  const window = yearWindow(year);
  const visible = plantings
    .map((planting) => ({ planting, segments: plantingSegments(planting) }))
    .filter(
      ({ segments }) =>
        segments.length === 0 ||
        segments.some(
          (segment) =>
            segment.startDate <= window.endDate &&
            (segment.endDate ?? segment.startDate) >= window.startDate,
        ),
    );
  const locations = new Map<string, typeof visible>();
  for (const entry of visible) {
    const key = entry.planting.locationId ?? "unplaced";
    const current = locations.get(key) ?? [];
    current.push(entry);
    locations.set(key, current);
  }
  return [...locations.entries()]
    .sort(([a, aRows], [b, bRows]) =>
      (
        aRows[0]?.planting.locationName ??
        (a === "unplaced" ? "No current location" : a)
      ).localeCompare(
        bRows[0]?.planting.locationName ??
          (b === "unplaced" ? "No current location" : b),
      ),
    )
    .flatMap(([locationId, entries]) => {
      const cropKeys = new Set(
        entries.flatMap(({ planting }) => {
          const key = guideKeyByPlant?.get(planting.plantId);
          return key ? [key] : [];
        }),
      );
      const guideRows = [...cropKeys]
        .sort((a, b) => cropName(a).localeCompare(cropName(b)))
        .flatMap((key) =>
          guideScheduleRows(year, key).map((row) => ({
            ...row,
            id: `${row.id}:location:${locationId}`,
            name: row.group ? `Guide: ${row.name}` : row.name,
            depth: row.depth + 1,
          })),
        );
      return [
        {
          id: `location:${locationId}`,
          name:
            entries[0]?.planting.locationName ??
            (locationId === "unplaced" ? "No current location" : locationId),
          depth: 0,
          group: true,
          segments: [],
        },
        ...entries
          .sort((a, b) =>
            a.planting.displayName.localeCompare(b.planting.displayName),
          )
          .map(({ planting, segments }) => ({
            id: `planting:${planting.id}`,
            name: planting.displayName,
            depth: 1,
            meta: `${planting.status}${planting.plannedWindow ? ` · Planned window: ${planting.plannedWindow}` : ""}`,
            metaShort: planting.status.replaceAll("_", " "),
            segments,
            noDateLabel:
              segments.length === 0
                ? planting.plannedWindow
                  ? `Planned window: ${planting.plannedWindow}`
                  : "No dated milestones"
                : undefined,
          })),
        ...guideRows,
      ];
    });
}

export const cropName = (key: GardenCropKey) => gardenCropLabel(key);
