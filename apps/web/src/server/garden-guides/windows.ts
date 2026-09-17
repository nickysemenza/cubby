/**
 * Sow/transplant recommendations derived on read from an ingredient's
 * `gardenGuideKey`, for the household's own microclimate (falling back to
 * the region-wide calendar). The guide data itself (`plantingGuides`) is
 * curated reference data in `@cubby/schemas/garden-guides`; this module only
 * resolves it for one household and formats it for display.
 */
import type {
  GardenGuideMethod,
  GardenGuideMicroclimate,
} from "@cubby/schemas/garden-guide";
import { gardenGuideKeys, plantingGuides } from "@cubby/schemas/garden-guides";

export type GardenGuideKey = (typeof gardenGuideKeys)[number];

const gardenGuideKeySet = new Set<string>(gardenGuideKeys);

/**
 * Loosely parses a DB `text` column into a known guide key — `null` for
 * unset, legacy, or otherwise-invalid data rather than throwing, since this
 * runs on every read.
 */
export function resolveGardenGuideKey(
  value: string | null | undefined,
): GardenGuideKey | null {
  // SAFETY: `gardenGuideKeySet` is built from `gardenGuideKeys`, the exact
  // literal union `GardenGuideKey` is derived from, so membership in the set
  // proves `value` is one of those literals.
  return value != null && gardenGuideKeySet.has(value)
    ? (value as GardenGuideKey)
    : null;
}

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

const guidesByKey = new Map(
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

/** The sow-window months only — the shape the planting timeline's
 * recommended-sow band needs. */
export const guideSowMonthsFor = (
  key: GardenGuideKey | null,
): number[] | null => guideMonthsFor(key, SOW_METHODS);

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
 * ingredient's `gardenGuideKey`. `null` on either side when the crop has no
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
