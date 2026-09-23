import { z } from "zod";

import { gardenGuideKeys, plantingGuides } from "./garden-guides";

/**
 * Household growing practice per crop: how a crop is started, how often it is
 * resown, and crop-level days to first harvest. Unlike `garden-guides.ts`
 * this is household knowledge, not source data, so its vocabulary is
 * deliberately distinct from the source `method` enum and a practice claim
 * never reads as a citation. A crop with no citable window lives here only.
 *
 * `maturity.source` is a `gardenPracticeSources` id or `"estimate"`; an
 * estimate always carries a `note` saying how it was derived. Cultivar
 * packet figures belong on the Plant, never here.
 */

/** Crops with practice but no citable source window yet. */
export const gardenPracticeOnlyKeys = [
  "asian-greens",
  "broccoli-raab",
  "cilantro",
  "dill",
  "parsley",
  "sorrel",
  "shiso",
  "tomatillo",
  "epazote",
  "fenugreek",
  "scallion",
  "bean-yardlong",
  "saffron",
  "celery-leaf",
  "alyssum",
  "nasturtium",
  "marigold",
] as const;

/** Every crop key a Plant may carry: source guide keys plus practice-only keys. */
export const gardenCropKeys = [
  ...gardenGuideKeys,
  ...gardenPracticeOnlyKeys,
] as const;
export const gardenCropKey = z.enum(gardenCropKeys);
export type GardenCropKey = z.infer<typeof gardenCropKey>;

export const gardenStart = z.enum(["direct", "tray", "indoor", "bought"]);
export type GardenStart = z.infer<typeof gardenStart>;

const days = z.number().int().positive();
const dayRange = z
  .tuple([days, days])
  .refine(([min, max]) => min <= max, "min must not exceed max");

export const gardenPracticeSource = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  url: z.url(),
  reviewedAt: z.iso.date(),
});

export const gardenPracticeEntry = z.object({
  /** Required for practice-only keys; guide keys take the guide's name. */
  name: z.string().min(1).optional(),
  starts: z.array(gardenStart).min(1),
  successionWeeks: z.number().int().positive().nullable(),
  maturity: z
    .object({
      fromSow: dayRange.nullable(),
      fromTransplant: dayRange.nullable(),
      source: z.string().min(1),
      note: z.string().min(1).optional(),
    })
    .nullable(),
});
export type GardenPracticeEntry = z.infer<typeof gardenPracticeEntry>;

export const gardenPracticeSources: z.input<typeof gardenPracticeSource>[] = [];

export const gardenPractice = {
  artichoke: {
    starts: ["tray", "indoor", "bought"],
    successionWeeks: null,
    maturity: {
      fromSow: null,
      fromTransplant: [180, 240],
      source: "estimate",
      note: "typical catalog range, not verified against a source page; perennial; crown/transplant to first head, ~6–8mo; SF coastal favors it as near-perennial",
    },
  },
  basil: {
    starts: ["direct", "tray", "indoor", "bought"],
    successionWeeks: null,
    maturity: {
      fromSow: [55, 65],
      fromTransplant: [25, 35],
      source: "estimate",
      note: "typical catalog range, not verified against a source page; transplant = sow−28d nursery",
    },
  },
  "bean-fava": {
    starts: ["direct"],
    successionWeeks: null,
    maturity: {
      fromSow: [75, 90],
      fromTransplant: null,
      source: "estimate",
      note: "typical catalog range, not verified against a source page; overwinters in SF coastal climate",
    },
  },
  "bean-runner": {
    starts: ["direct", "tray"],
    successionWeeks: null,
    maturity: {
      fromSow: [60, 70],
      fromTransplant: null,
      source: "estimate",
      note: "typical catalog range, not verified against a source page",
    },
  },
  "bean-snap": {
    starts: ["direct"],
    successionWeeks: 3,
    maturity: {
      fromSow: [50, 60],
      fromTransplant: null,
      source: "estimate",
      note: "typical catalog range, not verified against a source page; classic succession crop",
    },
  },
  beet: {
    starts: ["direct", "tray"],
    successionWeeks: 3,
    maturity: {
      fromSow: [50, 60],
      fromTransplant: null,
      source: "estimate",
      note: "typical catalog range, not verified against a source page",
    },
  },
  broccoli: {
    starts: ["tray", "indoor", "bought"],
    successionWeeks: null,
    maturity: {
      fromSow: [60, 70],
      fromTransplant: [50, 60],
      source: "estimate",
      note: "typical catalog range, not verified against a source page; fromSow = fromTransplant + ~10d nursery",
    },
  },
  "brussels-sprout": {
    starts: ["tray", "indoor", "bought"],
    successionWeeks: null,
    maturity: {
      fromSow: [90, 100],
      fromTransplant: [80, 90],
      source: "estimate",
      note: "typical catalog range, not verified against a source page; long season; estimate transplant lead ~10d",
    },
  },
  cabbage: {
    starts: ["tray", "indoor", "bought"],
    successionWeeks: null,
    maturity: {
      fromSow: [70, 90],
      fromTransplant: [60, 80],
      source: "estimate",
      note: "typical catalog range, not verified against a source page",
    },
  },
  carrot: {
    starts: ["direct"],
    successionWeeks: 3,
    maturity: {
      fromSow: [60, 75],
      fromTransplant: null,
      source: "estimate",
      note: "typical catalog range, not verified against a source page; taproot, direct-sow only",
    },
  },
  cauliflower: {
    starts: ["tray", "indoor", "bought"],
    successionWeeks: null,
    maturity: {
      fromSow: [65, 80],
      fromTransplant: [55, 70],
      source: "estimate",
      note: "typical catalog range, not verified against a source page",
    },
  },
  celery: {
    starts: ["tray", "indoor"],
    successionWeeks: null,
    maturity: {
      fromSow: null,
      fromTransplant: [90, 120],
      source: "estimate",
      note: "typical catalog range, not verified against a source page; long, slow-germinating; almost always transplanted",
    },
  },
  chard: {
    starts: ["direct", "tray"],
    successionWeeks: 4,
    maturity: {
      fromSow: [50, 60],
      fromTransplant: null,
      source: "estimate",
      note: "typical catalog range, not verified against a source page; cut-and-come-again",
    },
  },
  collard: {
    starts: ["direct", "tray", "bought"],
    successionWeeks: null,
    maturity: {
      fromSow: [60, 75],
      fromTransplant: [50, 60],
      source: "estimate",
      note: "typical catalog range, not verified against a source page",
    },
  },
  corn: {
    starts: ["direct"],
    successionWeeks: null,
    maturity: {
      fromSow: [65, 90],
      fromTransplant: null,
      source: "estimate",
      note: "typical catalog range, not verified against a source page; direct-sow only; not succession in small home beds typically, but growers do stagger — treat as no fixed succession interval",
    },
  },
  cucumber: {
    starts: ["direct", "tray", "indoor"],
    successionWeeks: 3,
    maturity: {
      fromSow: [50, 65],
      fromTransplant: [40, 55],
      source: "estimate",
      note: "typical catalog range, not verified against a source page; transplant = sow−10d",
    },
  },
  eggplant: {
    starts: ["tray", "indoor", "bought"],
    successionWeeks: null,
    maturity: {
      fromSow: null,
      fromTransplant: [60, 75],
      source: "estimate",
      note: "typical catalog range, not verified against a source page; needs heat; SF coastal marginal, grow from transplant",
    },
  },
  garlic: {
    starts: ["bought"],
    successionWeeks: null,
    maturity: {
      fromSow: null,
      fromTransplant: [240, 270],
      source: "estimate",
      note: "typical catalog range, not verified against a source page; perennial-style from cloves, fall-planted, ~8–9mo to harvest",
    },
  },
  kale: {
    starts: ["direct", "tray", "bought"],
    successionWeeks: 4,
    maturity: {
      fromSow: [55, 65],
      fromTransplant: [30, 40],
      source: "estimate",
      note: "typical catalog range, not verified against a source page; transplant = sow−25d",
    },
  },
  kohlrabi: {
    starts: ["direct", "tray"],
    successionWeeks: 3,
    maturity: {
      fromSow: [45, 60],
      fromTransplant: [35, 45],
      source: "estimate",
      note: "typical catalog range, not verified against a source page",
    },
  },
  leek: {
    starts: ["tray", "indoor"],
    successionWeeks: null,
    maturity: {
      fromSow: [90, 120],
      fromTransplant: [75, 100],
      source: "estimate",
      note: "typical catalog range, not verified against a source page; long season; estimate transplant = sow−20d",
    },
  },
  lettuce: {
    starts: ["direct", "tray", "bought"],
    successionWeeks: 3,
    maturity: {
      fromSow: [45, 55],
      fromTransplant: [25, 35],
      source: "estimate",
      note: "typical catalog range, not verified against a source page; classic succession crop; transplant = sow−20d",
    },
  },
  mustard: {
    starts: ["direct", "tray"],
    successionWeeks: 3,
    maturity: {
      fromSow: [30, 45],
      fromTransplant: null,
      source: "estimate",
      note: "typical catalog range, not verified against a source page; fast greens",
    },
  },
  onion: {
    starts: ["tray", "indoor", "bought"],
    successionWeeks: null,
    maturity: {
      fromSow: null,
      fromTransplant: [90, 120],
      source: "estimate",
      note: "typical catalog range, not verified against a source page; grown from sets/transplants; day-length dependent",
    },
  },
  parsnip: {
    starts: ["direct"],
    successionWeeks: null,
    maturity: {
      fromSow: [100, 120],
      fromTransplant: null,
      source: "estimate",
      note: "typical catalog range, not verified against a source page; slow, direct-sow only",
    },
  },
  pea: {
    starts: ["direct"],
    successionWeeks: 3,
    maturity: {
      fromSow: [55, 70],
      fromTransplant: null,
      source: "estimate",
      note: "typical catalog range, not verified against a source page; cool season, staggered sowings common",
    },
  },
  pepper: {
    starts: ["tray", "indoor", "bought"],
    successionWeeks: null,
    maturity: {
      fromSow: null,
      fromTransplant: [60, 80],
      source: "estimate",
      note: "typical catalog range, not verified against a source page; needs heat mat; SF coastal marginal",
    },
  },
  potato: {
    starts: ["bought"],
    successionWeeks: null,
    maturity: {
      fromSow: null,
      fromTransplant: [70, 90],
      source: "estimate",
      note: 'typical catalog range, not verified against a source page; from seed potatoes; "fromTransplant" = planting to first new potatoes',
    },
  },
  radish: {
    starts: ["direct"],
    successionWeeks: 2,
    maturity: {
      fromSow: [25, 35],
      fromTransplant: null,
      source: "estimate",
      note: "typical catalog range, not verified against a source page; fastest, classic short succession",
    },
  },
  rhubarb: {
    starts: ["bought"],
    successionWeeks: null,
    maturity: {
      fromSow: null,
      fromTransplant: [365, 730],
      source: "estimate",
      note: "typical catalog range, not verified against a source page; perennial crown; practical first harvest ~1–2 seasons after planting to let roots establish",
    },
  },
  shallot: {
    starts: ["bought"],
    successionWeeks: null,
    maturity: {
      fromSow: null,
      fromTransplant: [90, 120],
      source: "estimate",
      note: "typical catalog range, not verified against a source page; grown from sets like onion",
    },
  },
  spinach: {
    starts: ["direct", "tray"],
    successionWeeks: 3,
    maturity: {
      fromSow: [40, 50],
      fromTransplant: null,
      source: "estimate",
      note: "typical catalog range, not verified against a source page",
    },
  },
  "squash-summer": {
    starts: ["direct", "tray", "indoor"],
    successionWeeks: null,
    maturity: {
      fromSow: [50, 60],
      fromTransplant: [40, 50],
      source: "estimate",
      note: "typical catalog range, not verified against a source page; transplant = sow−10d",
    },
  },
  "squash-winter": {
    starts: ["direct", "tray", "indoor"],
    successionWeeks: null,
    maturity: {
      fromSow: [85, 100],
      fromTransplant: [75, 90],
      source: "estimate",
      note: "typical catalog range, not verified against a source page; transplant = sow−10d",
    },
  },
  sunflower: {
    starts: ["direct", "tray"],
    successionWeeks: null,
    maturity: {
      fromSow: [65, 85],
      fromTransplant: null,
      source: "estimate",
      note: "typical catalog range, not verified against a source page; days to bloom",
    },
  },
  tomato: {
    starts: ["tray", "indoor", "bought"],
    successionWeeks: null,
    maturity: {
      fromSow: null,
      fromTransplant: [60, 85],
      source: "estimate",
      note: "typical catalog range, not verified against a source page; almost always transplanted; SF coastal favors early/short-season varieties",
    },
  },
  turnip: {
    starts: ["direct"],
    successionWeeks: 3,
    maturity: {
      fromSow: [40, 55],
      fromTransplant: null,
      source: "estimate",
      note: "typical catalog range, not verified against a source page",
    },
  },
  melon: {
    starts: ["tray", "indoor"],
    successionWeeks: null,
    maturity: {
      fromSow: [75, 90],
      fromTransplant: [65, 80],
      source: "estimate",
      note: "typical catalog range, not verified against a source page; needs heat; SF coastal marginal, transplant = sow−10d",
    },
  },
  pumpkin: {
    starts: ["direct", "tray"],
    successionWeeks: null,
    maturity: {
      fromSow: [90, 110],
      fromTransplant: [80, 100],
      source: "estimate",
      note: "typical catalog range, not verified against a source page; transplant = sow−10d",
    },
  },
  rutabaga: {
    starts: ["direct"],
    successionWeeks: null,
    maturity: {
      fromSow: [80, 95],
      fromTransplant: null,
      source: "estimate",
      note: "typical catalog range, not verified against a source page",
    },
  },
  watermelon: {
    starts: ["tray", "indoor"],
    successionWeeks: null,
    maturity: {
      fromSow: [80, 90],
      fromTransplant: [70, 80],
      source: "estimate",
      note: "typical catalog range, not verified against a source page; needs heat; SF coastal marginal, transplant = sow−10d",
    },
  },
  "asian-greens": {
    name: "Asian greens",
    starts: ["direct", "tray"],
    successionWeeks: 3,
    maturity: {
      fromSow: [40, 55],
      fromTransplant: [25, 35],
      source: "estimate",
      note: "typical catalog range, not verified against a source page; fast cool-season greens; transplant = sow−15d",
    },
  },
  "broccoli-raab": {
    name: "Broccoli raab",
    starts: ["direct", "tray"],
    successionWeeks: 3,
    maturity: {
      fromSow: [40, 50],
      fromTransplant: null,
      source: "estimate",
      note: "typical catalog range, not verified against a source page",
    },
  },
  cilantro: {
    name: "Cilantro",
    starts: ["direct", "tray"],
    successionWeeks: 2,
    maturity: {
      fromSow: [45, 55],
      fromTransplant: null,
      source: "estimate",
      note: "typical catalog range, not verified against a source page; bolts fast; frequent succession standard",
    },
  },
  dill: {
    name: "Dill",
    starts: ["direct", "tray"],
    successionWeeks: 3,
    maturity: {
      fromSow: [40, 55],
      fromTransplant: null,
      source: "estimate",
      note: "typical catalog range, not verified against a source page",
    },
  },
  parsley: {
    name: "Parsley",
    starts: ["direct", "tray", "indoor"],
    successionWeeks: null,
    maturity: {
      fromSow: [70, 90],
      fromTransplant: [50, 60],
      source: "estimate",
      note: "typical catalog range, not verified against a source page; slow germination; transplant = sow−25d",
    },
  },
  sorrel: {
    name: "Sorrel",
    starts: ["direct", "tray"],
    successionWeeks: null,
    maturity: {
      fromSow: [55, 65],
      fromTransplant: null,
      source: "estimate",
      note: "typical catalog range, not verified against a source page; perennial-ish but grown as annual green",
    },
  },
  shiso: {
    name: "Shiso",
    starts: ["tray", "indoor"],
    successionWeeks: null,
    maturity: {
      fromSow: [70, 80],
      fromTransplant: [45, 55],
      source: "estimate",
      note: "typical catalog range, not verified against a source page; transplant = sow−25d",
    },
  },
  tomatillo: {
    name: "Tomatillo",
    starts: ["tray", "indoor", "bought"],
    successionWeeks: null,
    maturity: {
      fromSow: null,
      fromTransplant: [65, 80],
      source: "estimate",
      note: "typical catalog range, not verified against a source page; same culture as tomato",
    },
  },
  epazote: {
    name: "Epazote",
    starts: ["direct", "tray"],
    successionWeeks: null,
    maturity: {
      fromSow: [60, 80],
      fromTransplant: null,
      source: "estimate",
      note: "typical catalog range, not verified against a source page; estimate; sparse catalog data for this herb",
    },
  },
  fenugreek: {
    name: "Fenugreek",
    starts: ["direct"],
    successionWeeks: null,
    maturity: {
      fromSow: [40, 60],
      fromTransplant: null,
      source: "estimate",
      note: "typical catalog range, not verified against a source page; grown as microgreen/herb; estimate to first cutting",
    },
  },
  scallion: {
    name: "Scallion",
    starts: ["direct", "tray", "bought"],
    successionWeeks: 3,
    maturity: {
      fromSow: [50, 65],
      fromTransplant: [30, 45],
      source: "estimate",
      note: "typical catalog range, not verified against a source page; transplant = sow−20d",
    },
  },
  "bean-yardlong": {
    name: "Yardlong bean",
    starts: ["direct"],
    successionWeeks: null,
    maturity: {
      fromSow: [60, 80],
      fromTransplant: null,
      source: "estimate",
      note: "typical catalog range, not verified against a source page; heat-loving; SF coastal marginal",
    },
  },
  saffron: {
    name: "Saffron",
    starts: ["bought"],
    successionWeeks: null,
    maturity: {
      fromSow: null,
      fromTransplant: [365, 365],
      source: "estimate",
      note: "typical catalog range, not verified against a source page; corm-grown perennial (crocus); blooms ~6–8 weeks after fall planting but reliable harvest establishes over first full year — fromTransplant given as ~1 season to first meaningful bloom/harvest",
    },
  },
  "celery-leaf": {
    name: "Leaf celery",
    starts: ["tray", "indoor"],
    successionWeeks: null,
    maturity: {
      fromSow: null,
      fromTransplant: [70, 85],
      source: "estimate",
      note: "typical catalog range, not verified against a source page; smaller/faster than stalk celery; transplant only",
    },
  },
  alyssum: {
    name: "Alyssum",
    starts: ["direct", "tray", "bought"],
    successionWeeks: null,
    maturity: {
      fromSow: [40, 50],
      fromTransplant: [25, 35],
      source: "estimate",
      note: "typical catalog range, not verified against a source page; flower; days to first bloom; transplant = sow−15d",
    },
  },
  nasturtium: {
    name: "Nasturtium",
    starts: ["direct", "bought"],
    successionWeeks: null,
    maturity: {
      fromSow: [35, 50],
      fromTransplant: null,
      source: "estimate",
      note: "typical catalog range, not verified against a source page; flower; days to first bloom; direct-sow preferred, dislikes transplant",
    },
  },
  marigold: {
    name: "Marigold",
    starts: ["direct", "tray", "bought"],
    successionWeeks: null,
    maturity: {
      fromSow: [45, 55],
      fromTransplant: [30, 40],
      source: "estimate",
      note: "typical catalog range, not verified against a source page; flower; days to first bloom; transplant = sow−15d",
    },
  },
} satisfies Record<GardenCropKey, z.input<typeof gardenPracticeEntry>>;

/** Display label for a crop key: the source guide name, else the practice name. */
export const gardenCropLabel = (key: GardenCropKey): string => {
  const practice: z.input<typeof gardenPracticeEntry> = gardenPractice[key];
  return (
    plantingGuides.guides.find((guide) => guide.key === key)?.name ??
    practice.name ??
    key
  );
};
