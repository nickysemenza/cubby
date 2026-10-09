import { z } from "zod";

export const plantingStatus = z.enum(["planned", "growing", "finished"]);
export type PlantingStatus = z.infer<typeof plantingStatus>;
export const gardenEntryKind = z.enum(["note", "harvest"]);
export type GardenEntryKind = z.infer<typeof gardenEntryKind>;
export const plantingOutcome = z.enum(["succeeded", "failed"]);
export type PlantingOutcome = z.infer<typeof plantingOutcome>;
export const plantVerdict = z.enum(["yes", "maybe", "no"]);
export type PlantVerdict = z.infer<typeof plantVerdict>;
export const plantBreeding = z.enum(["open-pollinated", "hybrid"]);
export type PlantBreeding = z.infer<typeof plantBreeding>;

// Crop keys live here, not beside the guide data in `./garden-guides`, so a
// Plant declaration or route search can validate a key without loading the
// guide calendar.

/** Every guide key, in declaration order — usable directly by `z.enum`. */
export const gardenGuideKeys = [
  "artichoke",
  "basil",
  "bean-fava",
  "bean-runner",
  "bean-snap",
  "beet",
  "broccoli",
  "brussels-sprout",
  "cabbage",
  "carrot",
  "cauliflower",
  "celery",
  "chard",
  "collard",
  "corn",
  "cucumber",
  "eggplant",
  "garlic",
  "kale",
  "kohlrabi",
  "leek",
  "lettuce",
  "mustard",
  "onion",
  "parsnip",
  "pea",
  "pepper",
  "potato",
  "radish",
  "rhubarb",
  "shallot",
  "spinach",
  "squash-summer",
  "squash-winter",
  "sunflower",
  "tomato",
  "turnip",
  "melon",
  "pumpkin",
  "rutabaga",
  "watermelon",
] as const;

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
