/**
 * Sow/transplant recommendations derived on read from a Plant's crop key
 * (`gardenGuideKey`), for the household's own microclimate (falling back to
 * the region-wide calendar). The guide data itself (`plantingGuides`) is
 * curated reference data in `@cubby/schemas/garden-guides`; household practice
 * (start routes, crop maturity) is in `@cubby/schemas/garden-practice`. This
 * module only resolves both for one household and formats them for display.
 */
import type {
  GardenGuideMethod,
  GardenGuideMicroclimate,
} from "@cubby/schemas/garden-guide";
import { plantingGuides } from "@cubby/schemas/garden-guides";
import {
  type GardenCropKey,
  gardenCropKeys,
  gardenCropLabel,
  gardenPractice,
  gardenPracticeSources,
} from "@cubby/schemas/garden-practice";

export type GardenGuideKey = GardenCropKey;

const gardenCropKeySet = new Set<string>(gardenCropKeys);

/**
 * Loosely parses a DB `text` column into a known crop key — `null` for
 * unset, legacy, or otherwise-invalid data rather than throwing, since this
 * runs on every read.
 */
export function resolveGardenGuideKey(
  value: string | null | undefined,
): GardenGuideKey | null {
  // SAFETY: `gardenCropKeySet` is built from `gardenCropKeys`, the exact
  // literal union `GardenGuideKey` is derived from, so membership in the set
  // proves `value` is one of those literals.
  return value != null && gardenCropKeySet.has(value)
    ? (value as GardenGuideKey)
    : null;
}

/** `"<name> · <crop label>"`, or `name` alone without a crop or when the name
 * already is the crop label. Shared with Planting's title; it lives here, not
 * in `repo/plant`, so the garden readers import no repo module (a cycle). */
export const plantDisplayName = (
  name: string,
  gardenGuideKey: string | null,
): string => {
  const key = resolveGardenGuideKey(gardenGuideKey);
  if (key === null) return name;
  const label = gardenCropLabel(key);
  return label.toLowerCase() === name.toLowerCase()
    ? name
    : `${name} · ${label}`;
};

/** The planting's Plant display name — the canonical planting identity, shared
 * by `planting.displayName`, garden-entry planting references, and the
 * calendar's planting item title (`repo/calendar-plantings.ts`). */
export const plantingDisplayName = (
  row: { name: string; gardenGuideKey: string | null } | null,
) => (row ? plantDisplayName(row.name, row.gardenGuideKey) : "Unknown plant");

/** The household's own growing conditions; every other window falls back to
 * the regional calendar below. */
const HOUSEHOLD_MICROCLIMATE: GardenGuideMicroclimate = "sunny";
const FALLBACK_MICROCLIMATE: GardenGuideMicroclimate = "bay-area";

const SOW_METHODS: readonly GardenGuideMethod[] = ["sow", "direct-sow"];
const TRANSPLANT_METHODS: readonly GardenGuideMethod[] = ["transplant"];

const MONTH_ABBREVIATIONS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

const guidesByKey = new Map<string, (typeof plantingGuides.guides)[number]>(
  plantingGuides.guides.map((guide) => [guide.key, guide]),
);

/**
 * The recommended months for `key`'s `methods` (deduped, ascending),
 * preferring windows whose `microclimate` equals the household's; if none
 * qualify, falling back to windows for the region-wide microclimate; if
 * still none, `null`. Exported alongside {@link guideWindowsFor}'s formatted
 * text so a caller that needs an actual dated interval (the planting
 * timeline's recommended-sow band) can build one from the same resolved
 * months instead of re-parsing formatted text.
 */
function guideMonthsFor(
  key: GardenGuideKey | null,
  methods: readonly GardenGuideMethod[],
): number[] | null {
  if (key === null) return null;
  const guide = guidesByKey.get(key);
  if (!guide) return null;
  const candidates = guide.windows.filter((window) =>
    methods.includes(window.method),
  );
  if (candidates.length === 0) return null;
  const preferred = candidates.filter(
    (window) => window.microclimate === HOUSEHOLD_MICROCLIMATE,
  );
  const chosen =
    preferred.length > 0
      ? preferred
      : candidates.filter(
          (window) => window.microclimate === FALLBACK_MICROCLIMATE,
        );
  if (chosen.length === 0) return null;
  return [...new Set(chosen.flatMap((window) => window.months))].sort(
    (a, b) => a - b,
  );
}

/** The resolved months per guide method — a named contract for the planting
 * timeline's recommended bands (one band per method that has a window). */
export type GuideBandMonths = {
  sow: number[] | null;
  transplant: number[] | null;
};

export const guideBandMonthsFor = (
  key: GardenGuideKey | null,
): GuideBandMonths => ({
  sow: guideMonthsFor(key, SOW_METHODS),
  transplant: guideMonthsFor(key, TRANSPLANT_METHODS),
});

/** `[2, 3, 4]` -> `"Feb–Apr"`; non-contiguous runs join with `", "`
 * (`[8, 9, 10, 1]` -> `"Aug–Oct, Jan"`). Assumes months are 1–12 and does not
 * wrap Dec into Jan. */
function formatMonths(months: readonly number[]): string {
  const sorted = [...months].sort((a, b) => a - b);
  const runs: number[][] = [];
  for (const month of sorted) {
    const current = runs.at(-1);
    const last = current?.at(-1);
    if (current && last !== undefined && month === last + 1) {
      current.push(month);
    } else {
      runs.push([month]);
    }
  }
  return runs
    .map((run) => {
      const start = MONTH_ABBREVIATIONS[run[0]! - 1];
      const end = MONTH_ABBREVIATIONS[run.at(-1)! - 1];
      return run.length === 1 ? start : `${start}–${end}`;
    })
    .join(", ");
}

/** The formatted `guideWindowsFor` result — a named contract so its return
 * type carries evidence instead of an inline object-literal type. */
export type GuideWindows = {
  sow: string | null;
  transplant: string | null;
};

/**
 * Formatted sow/transplant recommendation, derived on read from an
 * plant's crop key. `null` on either side when the crop has no
 * guide, or no window of that method for the household's or the fallback
 * microclimate.
 */
export function guideWindowsFor(key: GardenGuideKey | null): GuideWindows {
  const sowMonths = guideMonthsFor(key, SOW_METHODS);
  const transplantMonths = guideMonthsFor(key, TRANSPLANT_METHODS);
  return {
    sow: sowMonths ? formatMonths(sowMonths) : null,
    transplant: transplantMonths ? formatMonths(transplantMonths) : null,
  };
}

const monthsText = (months: number[] | null): string | null =>
  months ? formatMonths(months) : null;

/**
 * One clause per declared start route, read against this month: seed routes
 * (`direct`, `tray`, `indoor`) against the sow window, `bought` against the
 * transplant window, and seed routes other than `direct` also report where
 * they plant out. `null` when the crop has no practice entry.
 */
export function plantRoutesFor(
  key: GardenGuideKey | null,
  month: number,
): string | null {
  if (key === null) return null;
  const { sow, transplant } = guideBandMonthsFor(key);
  const clause = (label: string, months: number[] | null) =>
    months === null
      ? `${label} (no guide window)`
      : months.includes(month)
        ? `${label} now`
        : `${label} ${formatMonths(months)}`;
  return gardenPractice[key].starts
    .map((start) => {
      if (start === "bought")
        return `bought: ${clause("plant out", transplant)}`;
      const sowing = clause("sow", sow);
      if (start === "direct" || transplant === null)
        return `${start}: ${sowing}`;
      return `${start}: ${sowing}, plant out ${monthsText(transplant)}`;
    })
    .join(" · ");
}

type DayRange = readonly [number, number];

/** Cultivar days from the Plant's packet fields; either side may be unset. */
export type PlantMaturityDays = {
  daysFromSowMin: number | null;
  daysFromSowMax: number | null;
  daysFromTransplantMin: number | null;
  daysFromTransplantMax: number | null;
};

export type ExpectedHarvest = {
  start: string;
  end: string;
  /** "cultivar packet", a cited crop source's name, or "crop estimate". */
  basis: string;
  summary: string;
};

const packetRange = (
  min: number | null,
  max: number | null,
): DayRange | null =>
  min === null && max === null ? null : [min ?? max!, max ?? min!];

const addDays = (date: string, days: number): string => {
  const next = new Date(`${date}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + days);
  return next.toISOString().slice(0, 10);
};

const formatDay = (date: string): string => {
  const [, month, day] = date.split("-").map(Number);
  return `${MONTH_ABBREVIATIONS[month! - 1]} ${day}`;
};

/** A crop range's basis: its cited source's name, else "crop estimate". */
const cropBasis = (source: string | undefined): string =>
  gardenPracticeSources.find((cited) => cited.id === source)?.name ??
  "crop estimate";

/**
 * The expected first-harvest range: `transplantedOn` plus the transplant
 * range, else `sowedOn` plus the sow range. Cultivar packet days win over the
 * crop-level practice estimate for the same anchor. A bought seedling is just
 * a planting with `transplantedOn` and no `sowedOn`. `null` without a real
 * date or any matching days.
 */
export function expectedHarvestFor(args: {
  key: GardenGuideKey | null;
  plant: PlantMaturityDays | null;
  sowedOn: string | null;
  transplantedOn: string | null;
}): ExpectedHarvest | null {
  const maturity = args.key ? gardenPractice[args.key].maturity : null;
  const anchors = [
    {
      date: args.transplantedOn,
      packet: args.plant
        ? packetRange(
            args.plant.daysFromTransplantMin,
            args.plant.daysFromTransplantMax,
          )
        : null,
      crop: maturity?.fromTransplant ?? null,
    },
    {
      date: args.sowedOn,
      packet: args.plant
        ? packetRange(args.plant.daysFromSowMin, args.plant.daysFromSowMax)
        : null,
      crop: maturity?.fromSow ?? null,
    },
    // A transplant with only sow-based days: late, which is the safe side.
    {
      date: args.transplantedOn,
      packet: args.plant
        ? packetRange(args.plant.daysFromSowMin, args.plant.daysFromSowMax)
        : null,
      crop: maturity?.fromSow ?? null,
    },
  ];
  for (const anchor of anchors) {
    if (anchor.date === null) continue;
    const range = anchor.packet ?? anchor.crop;
    if (range === null) continue;
    const basis =
      anchor.packet !== null ? "cultivar packet" : cropBasis(maturity?.source);
    const start = addDays(anchor.date, range[0]);
    const end = addDays(anchor.date, range[1]);
    const span =
      start === end
        ? formatDay(start)
        : `${formatDay(start)} – ${formatDay(end)}`;
    return { start, end, basis, summary: `${span} (${basis})` };
  }
  return null;
}
