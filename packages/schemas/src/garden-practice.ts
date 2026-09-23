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
 * estimate always carries a `note` saying how it was derived. Cited ranges
 * are p10–p90 of the source's listings (min–max under ten listings) in the
 * source's own days-to-maturity convention, which the note names. Perennials
 * and trees bought as plants have no maturity. Cultivar packet figures
 * belong on the Plant, never here.
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
  "mint",
  "thyme",
  "oregano",
  "mexican-oregano",
  "chives",
  "garlic-chives",
  "rau-ram",
  "hoja-santa",
  "strawberry",
  "passion-fruit",
  "citrus",
  "curry-leaf",
  "sichuan-pepper",
  "plum",
  "poppy",
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

export const gardenPracticeSources: z.input<typeof gardenPracticeSource>[] = [
  {
    id: "johnnys",
    name: "Johnny's Selected Seeds",
    url: "https://www.johnnyseeds.com/growers-library/",
    reviewedAt: "2026-09-23",
  },
  {
    id: "adaptive",
    name: "Adaptive Seeds",
    url: "https://www.adaptiveseeds.com/product/herbs/epazote-oaxaca-red-organic/",
    reviewedAt: "2026-09-23",
  },
  {
    id: "trueleaf",
    name: "True Leaf Market",
    url: "https://trueleafmarket.com/products/yard-long-bean-dark-green",
    reviewedAt: "2026-09-23",
  },
  {
    id: "garden-organic",
    name: "Garden Organic",
    url: "https://www.gardenorganic.org.uk/expert-advice/how-to-grow/growing-guides/vegetables-herbs-guides/how-to-grow-fenugreek",
    reviewedAt: "2026-09-23",
  },
  {
    id: "uvm-saffron",
    name: "UVM Saffron Center",
    url: "https://www.uvm.edu/~saffron/pages/factsheets/SaffronplantingforhomegardenersSept2021.pdf",
    reviewedAt: "2026-09-23",
  },
];

export const gardenPractice = {
  artichoke: {
    starts: ["tray", "indoor", "bought"],
    successionWeeks: null,
    maturity: {
      fromSow: null,
      fromTransplant: [75, 85],
      source: "johnnys",
      note: "Johnny's range of 3 listings; KGI counts from transplant; annual culture after vernalization",
    },
  },
  basil: {
    starts: ["direct", "tray", "indoor", "bought"],
    successionWeeks: null,
    maturity: {
      fromSow: [55, 74],
      fromTransplant: null,
      source: "johnnys",
      note: "Johnny's p10–p90 of 35 listings; KGI states no convention; read as from sowing",
    },
  },
  "bean-fava": {
    starts: ["direct"],
    successionWeeks: null,
    maturity: {
      fromSow: [75, 75],
      fromTransplant: null,
      source: "johnnys",
      note: "Johnny's range of 1 listing; KGI states no convention; read as from sowing",
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
      fromSow: [51, 60],
      fromTransplant: null,
      source: "johnnys",
      note: "Johnny's p10–p90 of 25 listings; KGI counts from direct seeding; bush and pole",
    },
  },
  beet: {
    starts: ["direct", "tray"],
    successionWeeks: 3,
    maturity: {
      fromSow: [46, 55],
      fromTransplant: [25, 41],
      source: "johnnys",
      note: "Johnny's p10–p90 of 12 listings; KGI counts from direct seeding; transplants mature 14–21 days sooner",
    },
  },
  broccoli: {
    starts: ["tray", "indoor", "bought"],
    successionWeeks: null,
    maturity: {
      fromSow: [77, 86],
      fromTransplant: [57, 66],
      source: "johnnys",
      note: "Johnny's p10–p90 of 11 listings; KGI counts from transplant; direct seeding adds 20 days",
    },
  },
  "brussels-sprout": {
    starts: ["tray", "indoor", "bought"],
    successionWeeks: null,
    maturity: {
      fromSow: null,
      fromTransplant: [98, 118],
      source: "johnnys",
      note: "Johnny's range of 5 listings; KGI counts from transplant",
    },
  },
  cabbage: {
    starts: ["tray", "indoor", "bought"],
    successionWeeks: null,
    maturity: {
      fromSow: null,
      fromTransplant: [65, 98],
      source: "johnnys",
      note: "Johnny's p10–p90 of 20 listings; KGI counts from transplant; spring transplant; 10–14 days less in warm weather",
    },
  },
  carrot: {
    starts: ["direct"],
    successionWeeks: 3,
    maturity: {
      fromSow: [56, 75],
      fromTransplant: null,
      source: "johnnys",
      note: "Johnny's p10–p90 of 31 listings; KGI counts from direct seeding",
    },
  },
  cauliflower: {
    starts: ["tray", "indoor", "bought"],
    successionWeeks: null,
    maturity: {
      fromSow: null,
      fromTransplant: [50, 80],
      source: "johnnys",
      note: "Johnny's p10–p90 of 27 listings; KGI counts from transplant; overwintering types excluded",
    },
  },
  celery: {
    starts: ["tray", "indoor"],
    successionWeeks: null,
    maturity: {
      fromSow: null,
      fromTransplant: [80, 100],
      source: "johnnys",
      note: "Johnny's range of 5 listings; KGI counts from transplant",
    },
  },
  chard: {
    starts: ["direct", "tray"],
    successionWeeks: 4,
    maturity: {
      fromSow: [50, 65],
      fromTransplant: null,
      source: "johnnys",
      note: "Johnny's range of 9 listings; KGI counts from direct seeding; to bunching",
    },
  },
  collard: {
    starts: ["direct", "tray", "bought"],
    successionWeeks: null,
    maturity: {
      fromSow: [50, 55],
      fromTransplant: [36, 41],
      source: "johnnys",
      note: "Johnny's range of 3 listings; KGI counts from direct seeding; transplants mature 14 days sooner",
    },
  },
  corn: {
    starts: ["direct"],
    successionWeeks: null,
    maturity: {
      fromSow: [68, 110],
      fromTransplant: null,
      source: "johnnys",
      note: "Johnny's p10–p90 of 35 listings; KGI counts from direct seeding",
    },
  },
  cucumber: {
    starts: ["direct", "tray", "indoor"],
    successionWeeks: 3,
    maturity: {
      fromSow: null,
      fromTransplant: [29, 43],
      source: "johnnys",
      note: "Johnny's p10–p90 of 32 listings; KGI counts from transplant",
    },
  },
  eggplant: {
    starts: ["tray", "indoor", "bought"],
    successionWeeks: null,
    maturity: {
      fromSow: null,
      fromTransplant: [55, 65],
      source: "johnnys",
      note: "Johnny's p10–p90 of 20 listings; KGI counts from transplant",
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
      fromSow: [50, 65],
      fromTransplant: [36, 51],
      source: "johnnys",
      note: "Johnny's p10–p90 of 14 listings; KGI counts from direct seeding; transplants mature 14 days sooner; full size; baby-only listings and Kalettes excluded",
    },
  },
  kohlrabi: {
    starts: ["direct", "tray"],
    successionWeeks: 3,
    maturity: {
      fromSow: [37, 48],
      fromTransplant: [23, 34],
      source: "johnnys",
      note: "Johnny's range of 6 listings; KGI counts from direct seeding; transplants mature 14 days sooner; fresh-market types; storage Kossak (80) excluded",
    },
  },
  leek: {
    starts: ["tray", "indoor"],
    successionWeeks: null,
    maturity: {
      fromSow: [95, 150],
      fromTransplant: [75, 120],
      source: "johnnys",
      note: "Johnny's range of 8 listings; KGI counts from transplant; direct seeding adds 20–30 days",
    },
  },
  lettuce: {
    starts: ["direct", "tray", "bought"],
    successionWeeks: 3,
    maturity: {
      fromSow: null,
      fromTransplant: [34, 57],
      source: "johnnys",
      note: "Johnny's p10–p90 of 109 listings; KGI counts from transplant; full size",
    },
  },
  mustard: {
    starts: ["direct", "tray"],
    successionWeeks: 3,
    maturity: {
      fromSow: [37, 45],
      fromTransplant: null,
      source: "johnnys",
      note: "Johnny's p10–p90 of 10 listings; KGI counts from direct seeding; full size",
    },
  },
  onion: {
    starts: ["tray", "indoor", "bought"],
    successionWeeks: null,
    maturity: {
      fromSow: [90, 115],
      fromTransplant: [75, 105],
      source: "johnnys",
      note: "Johnny's p10–p90 of 24 listings; KGI counts from direct seeding; transplants mature 10–15 days sooner; spring-sown; fall-planted listings excluded",
    },
  },
  parsnip: {
    starts: ["direct"],
    successionWeeks: null,
    maturity: {
      fromSow: [105, 120],
      fromTransplant: null,
      source: "johnnys",
      note: "Johnny's range of 5 listings; KGI counts from direct seeding",
    },
  },
  pea: {
    starts: ["direct"],
    successionWeeks: 3,
    maturity: {
      fromSow: [55, 64],
      fromTransplant: null,
      source: "johnnys",
      note: "Johnny's p10–p90 of 16 listings; KGI counts from direct seeding",
    },
  },
  pepper: {
    starts: ["tray", "indoor", "bought"],
    successionWeeks: null,
    maturity: {
      fromSow: null,
      fromTransplant: [55, 70],
      source: "johnnys",
      note: "Johnny's p10–p90 of 76 listings; KGI counts from transplant; to first full-size fruit",
    },
  },
  potato: {
    starts: ["bought"],
    successionWeeks: null,
    maturity: {
      fromSow: null,
      fromTransplant: [49, 56],
      source: "johnnys",
      note: "KGI: new potatoes 7–8 weeks after planting; storage potatoes run longer",
    },
  },
  radish: {
    starts: ["direct"],
    successionWeeks: 2,
    maturity: {
      fromSow: [21, 55],
      fromTransplant: null,
      source: "johnnys",
      note: "Johnny's p10–p90 of 23 listings; KGI counts from direct seeding; round through daikon",
    },
  },
  rhubarb: {
    starts: ["bought"],
    successionWeeks: null,
    maturity: {
      fromSow: null,
      fromTransplant: [365, 730],
      source: "johnnys",
      note: "Johnny's Victoria: harvest the second year after planting",
    },
  },
  shallot: {
    starts: ["bought"],
    successionWeeks: null,
    maturity: {
      fromSow: [105, 110],
      fromTransplant: [90, 100],
      source: "johnnys",
      note: "Johnny's range of 4 listings; KGI counts from direct seeding; transplants mature 10–15 days sooner",
    },
  },
  spinach: {
    starts: ["direct", "tray"],
    successionWeeks: 3,
    maturity: {
      fromSow: [25, 30],
      fromTransplant: null,
      source: "johnnys",
      note: "Johnny's p10–p90 of 16 listings; KGI counts from direct seeding",
    },
  },
  "squash-summer": {
    starts: ["direct", "tray", "indoor"],
    successionWeeks: null,
    maturity: {
      fromSow: [45, 54],
      fromTransplant: [31, 40],
      source: "johnnys",
      note: "Johnny's p10–p90 of 27 listings; KGI counts from direct seeding; transplants mature 14 days sooner",
    },
  },
  "squash-winter": {
    starts: ["direct", "tray", "indoor"],
    successionWeeks: null,
    maturity: {
      fromSow: [88, 105],
      fromTransplant: [74, 91],
      source: "johnnys",
      note: "Johnny's p10–p90 of 37 listings; KGI counts from direct seeding; transplants mature 14 days sooner",
    },
  },
  sunflower: {
    starts: ["direct", "tray"],
    successionWeeks: null,
    maturity: {
      fromSow: [50, 85],
      fromTransplant: null,
      source: "johnnys",
      note: "Johnny's p10–p90 of 55 listings; KGI states no convention; read as from sowing; days to bloom",
    },
  },
  tomato: {
    starts: ["tray", "indoor", "bought"],
    successionWeeks: null,
    maturity: {
      fromSow: null,
      fromTransplant: [59, 78],
      source: "johnnys",
      note: "Johnny's p10–p90 of 117 listings; KGI counts from transplant",
    },
  },
  turnip: {
    starts: ["direct"],
    successionWeeks: 3,
    maturity: {
      fromSow: [38, 50],
      fromTransplant: null,
      source: "johnnys",
      note: "Johnny's range of 3 listings; KGI counts from direct seeding",
    },
  },
  melon: {
    starts: ["tray", "indoor"],
    successionWeeks: null,
    maturity: {
      fromSow: [81, 88],
      fromTransplant: [71, 78],
      source: "johnnys",
      note: "Johnny's p10–p90 of 21 listings; KGI counts from transplant; direct seeding adds 10 days",
    },
  },
  pumpkin: {
    starts: ["direct", "tray"],
    successionWeeks: null,
    maturity: {
      fromSow: [85, 110],
      fromTransplant: [71, 96],
      source: "johnnys",
      note: "Johnny's p10–p90 of 51 listings; KGI counts from direct seeding; transplants mature 14 days sooner",
    },
  },
  rutabaga: {
    starts: ["direct"],
    successionWeeks: null,
    maturity: {
      fromSow: [90, 95],
      fromTransplant: null,
      source: "johnnys",
      note: "Johnny's range of 2 listings; KGI counts from direct seeding",
    },
  },
  watermelon: {
    starts: ["tray", "indoor"],
    successionWeeks: null,
    maturity: {
      fromSow: [80, 97],
      fromTransplant: [70, 87],
      source: "johnnys",
      note: "Johnny's p10–p90 of 16 listings; KGI counts from transplant; direct seeding adds 10 days",
    },
  },
  "asian-greens": {
    name: "Asian greens",
    starts: ["direct", "tray"],
    successionWeeks: 3,
    maturity: {
      fromSow: [35, 55],
      fromTransplant: null,
      source: "johnnys",
      note: "Johnny's p10–p90 of 27 listings; KGI counts from direct seeding; full size; baby-only listings excluded",
    },
  },
  "broccoli-raab": {
    name: "Broccoli raab",
    starts: ["direct", "tray"],
    successionWeeks: 3,
    maturity: {
      fromSow: [42, 42],
      fromTransplant: null,
      source: "johnnys",
      note: "Johnny's range of 1 listing; KGI states no convention; read as from sowing; Spring Raab is the only raab listing",
    },
  },
  cilantro: {
    name: "Cilantro",
    starts: ["direct", "tray"],
    successionWeeks: 2,
    maturity: {
      fromSow: [50, 55],
      fromTransplant: null,
      source: "johnnys",
      note: "Johnny's range of 7 listings; KGI states no convention; read as from sowing; to leaf harvest",
    },
  },
  dill: {
    name: "Dill",
    starts: ["direct", "tray"],
    successionWeeks: 3,
    maturity: {
      fromSow: [40, 60],
      fromTransplant: null,
      source: "johnnys",
      note: "Johnny's range of 7 listings; KGI states no convention; read as from sowing; to leaf harvest",
    },
  },
  parsley: {
    name: "Parsley",
    starts: ["direct", "tray", "indoor"],
    successionWeeks: null,
    maturity: {
      fromSow: [75, 75],
      fromTransplant: null,
      source: "johnnys",
      note: "Johnny's range of 9 listings; KGI states no convention; read as from sowing",
    },
  },
  sorrel: {
    name: "Sorrel",
    starts: ["direct", "tray"],
    successionWeeks: null,
    maturity: {
      fromSow: [55, 60],
      fromTransplant: [41, 46],
      source: "johnnys",
      note: "Johnny's range of 2 listings; KGI counts from direct seeding; transplants mature 14 days sooner; full size",
    },
  },
  shiso: {
    name: "Shiso",
    starts: ["tray", "indoor"],
    successionWeeks: null,
    maturity: {
      fromSow: [80, 85],
      fromTransplant: null,
      source: "johnnys",
      note: "Johnny's range of 4 listings; KGI states no convention; read as from sowing",
    },
  },
  tomatillo: {
    name: "Tomatillo",
    starts: ["tray", "indoor", "bought"],
    successionWeeks: null,
    maturity: {
      fromSow: null,
      fromTransplant: [60, 70],
      source: "johnnys",
      note: "Johnny's range of 3 listings; KGI counts from transplant",
    },
  },
  epazote: {
    name: "Epazote",
    starts: ["direct", "tray"],
    successionWeeks: null,
    maturity: {
      fromSow: [55, 70],
      fromTransplant: null,
      source: "adaptive",
      note: "Adaptive Oaxaca Red lists 60–70 days; Fedco lists 55",
    },
  },
  fenugreek: {
    name: "Fenugreek",
    starts: ["direct"],
    successionWeeks: null,
    maturity: {
      fromSow: [28, 42],
      fromTransplant: null,
      source: "garden-organic",
      note: "leaf harvest; Garden Organic gives four weeks average, six weeks depending on weather",
    },
  },
  scallion: {
    name: "Scallion",
    starts: ["direct", "tray", "bought"],
    successionWeeks: 3,
    maturity: {
      fromSow: [50, 65],
      fromTransplant: [35, 55],
      source: "johnnys",
      note: "Johnny's range of 6 listings; KGI counts from direct seeding; transplants mature 10–15 days sooner",
    },
  },
  "bean-yardlong": {
    name: "Yardlong bean",
    starts: ["direct"],
    successionWeeks: null,
    maturity: {
      fromSow: [70, 89],
      fromTransplant: null,
      source: "trueleaf",
      note: "True Leaf yardlong listings: 70–79 days (five), 80–89 (Oriental)",
    },
  },
  saffron: {
    name: "Saffron",
    starts: ["bought"],
    successionWeeks: null,
    maturity: {
      fromSow: null,
      fromTransplant: [30, 45],
      source: "uvm-saffron",
      note: "corms sprout ~30 days after August–September planting and flower soon after",
    },
  },
  "celery-leaf": {
    name: "Leaf celery",
    starts: ["tray", "indoor"],
    successionWeeks: null,
    maturity: {
      fromSow: [80, 85],
      fromTransplant: null,
      source: "johnnys",
      note: "Johnny's range of 1 listing; KGI states no convention; read as from sowing",
    },
  },
  alyssum: {
    name: "Alyssum",
    starts: ["direct", "tray", "bought"],
    successionWeeks: null,
    maturity: {
      fromSow: [50, 60],
      fromTransplant: null,
      source: "johnnys",
      note: "Johnny's range of 2 listings; KGI states no convention; read as from sowing; days to bloom",
    },
  },
  nasturtium: {
    name: "Nasturtium",
    starts: ["direct", "bought"],
    successionWeeks: null,
    maturity: {
      fromSow: [55, 65],
      fromTransplant: null,
      source: "johnnys",
      note: "Johnny's range of 7 listings; KGI states no convention; read as from sowing; days to bloom",
    },
  },
  marigold: {
    name: "Marigold",
    starts: ["direct", "tray", "bought"],
    successionWeeks: null,
    maturity: {
      fromSow: [50, 90],
      fromTransplant: null,
      source: "johnnys",
      note: "Johnny's p10–p90 of 16 listings; KGI states no convention; read as from sowing; days to bloom",
    },
  },
  mint: {
    name: "Mint",
    starts: ["bought"],
    successionWeeks: null,
    maturity: {
      fromSow: [70, 80],
      fromTransplant: null,
      source: "johnnys",
      note: "Johnny's range of 1 listing; KGI states no convention; read as from sowing",
    },
  },
  thyme: {
    name: "Thyme",
    starts: ["tray", "bought"],
    successionWeeks: null,
    maturity: {
      fromSow: [90, 95],
      fromTransplant: null,
      source: "johnnys",
      note: "Johnny's range of 3 listings; KGI states no convention; read as from sowing",
    },
  },
  oregano: {
    name: "Oregano",
    starts: ["tray", "bought"],
    successionWeeks: null,
    maturity: {
      fromSow: [80, 90],
      fromTransplant: null,
      source: "johnnys",
      note: "Johnny's range of 1 listing; KGI states no convention; read as from sowing",
    },
  },
  "mexican-oregano": {
    name: "Mexican oregano",
    starts: ["bought"],
    successionWeeks: null,
    maturity: null,
  },
  chives: {
    name: "Chives",
    starts: ["tray", "bought"],
    successionWeeks: null,
    maturity: {
      fromSow: [75, 85],
      fromTransplant: null,
      source: "johnnys",
      note: "Johnny's range of 6 listings; KGI states no convention; read as from sowing",
    },
  },
  "garlic-chives": {
    name: "Garlic chives",
    starts: ["tray", "bought"],
    successionWeeks: null,
    maturity: {
      fromSow: [80, 90],
      fromTransplant: null,
      source: "johnnys",
      note: "Johnny's range of 2 listings; KGI states no convention; read as from sowing",
    },
  },
  "rau-ram": {
    name: "Vietnamese coriander",
    starts: ["bought"],
    successionWeeks: null,
    maturity: null,
  },
  "hoja-santa": {
    name: "Hoja santa",
    starts: ["bought"],
    successionWeeks: null,
    maturity: null,
  },
  strawberry: {
    name: "Strawberry",
    starts: ["bought", "indoor"],
    successionWeeks: null,
    maturity: {
      fromSow: [100, 120],
      fromTransplant: null,
      source: "johnnys",
      note: "Johnny's range of 3 listings; KGI states no convention; read as from sowing; seed-grown day-neutral types, to fruit",
    },
  },
  "passion-fruit": {
    name: "Passion fruit",
    starts: ["bought"],
    successionWeeks: null,
    maturity: null,
  },
  citrus: {
    name: "Citrus",
    starts: ["bought"],
    successionWeeks: null,
    maturity: null,
  },
  "curry-leaf": {
    name: "Curry leaf",
    starts: ["bought"],
    successionWeeks: null,
    maturity: null,
  },
  "sichuan-pepper": {
    name: "Sichuan pepper",
    starts: ["bought"],
    successionWeeks: null,
    maturity: null,
  },
  plum: {
    name: "Plum",
    starts: ["bought"],
    successionWeeks: null,
    maturity: null,
  },
  poppy: {
    name: "Poppy",
    starts: ["direct"],
    successionWeeks: null,
    maturity: {
      fromSow: [55, 65],
      fromTransplant: null,
      source: "johnnys",
      note: "Johnny's range of 2 listings; KGI states no convention; read as from sowing; corn and California poppy, days to bloom; Iceland poppies excluded",
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
