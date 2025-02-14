import { type Amount } from "~/codec/codec";
import {
  type DataConfig,
  type InfLocationConfig,
  type ProductConfigItem,
} from "~/schemas/config";
import { type LocationType } from "~/schemas/location";
import { type UnitMapping } from "~/schemas/unitmapping";

// amount from unit and value
const uv = (value: number, unit: string): Amount => ({ unit, value });
// unit mappings from unit value pair
const uvp = (
  valueA: number,
  unitA: string,
  valueB: number,
  unitB: string,
  source: string,
): UnitMapping => ({
  a: uv(valueA, unitA),
  b: uv(valueB, unitB),
  source: source,
});
// generic product
const gp = (name: string): ProductConfigItem => ({
  name,
  manufacturer: "generic",
});
// product (non-ingredient)
const p = (
  name: string,
  upc: string,
  manufacturer: string,
  model: string,
  price_per: number,
): ProductConfigItem => ({
  name,
  manufacturer,
  upc,
  model,
  price_per,
});
// product (ingredient)
const i = (
  name: string,
  upc: string,
  manufacturer: string,
  unit_mappings: UnitMapping[],
): ProductConfigItem => ({
  name,
  ingredient: true,
  manufacturer,
  upc,
  unit_mappings,
});
// product (generic ingredient
const gi = (name: string, unit_mappings: UnitMapping[]): ProductConfigItem => ({
  name,
  ingredient: true,
  manufacturer: "generic",
  unit_mappings,
});
// location
const lp = (
  name: string,
  type: LocationType,
  products: ProductConfigItem[],
): InfLocationConfig => ({
  name,
  type,
  products,
});
const lc = (
  name: string,
  type: LocationType,
  children: InfLocationConfig[],
): InfLocationConfig => ({
  name,
  type,
  children,
});

const densityOil = uvp(1, "ml", 0.9, "g", "unk");
const densityWater = uvp(1, "ml", 1, "g", "unk");
const flourDensity = uvp(1, "cup", 120, "g", "unk");

export const aliases: Record<string, string[]> = {
  "all purpose flour": ["AP flour", "flour", "white flour"],
  "olive oil": ["Extra Virgin Olive Oil", "evoo"],
  butter: ["unsalted butter"],
  egg: [
    "eggs",
    "large egg",
    "large eggs",
    "large brown eggs",
    "large brown egg",
  ],
};

const garage: InfLocationConfig = lc("garage", "room", [
  lp("toolbag", "bag", [
    p("Packout toolbag", "045242505296", "Milwaukee", "48-22-8315", 99),
  ]),
  lc("chrome wire shelf", "shelf", [
    lp("oscillating and grinder", "half-crate", [
      p("Ryobi Angle Grinder", "033287188048", "Ryobi", "PBLAG01B", 129),
      p("Ryobi Oscillating Tool", "033287190706", "Ryobi", "PBLMT50B", 129),
      gp("angle grinder discs"),
      gp("oscillating toolblades"),
    ]),

    lp("bin B", "crate", []),
    lp("bin C", "crate", []),
  ]),
  lc("black wire shelf", "shelf", []),
  lc("white metal shelf", "shelf", []),
  lc("packout wall", "shelf", []),
  lc("butcher block workbench", "table", []),
  lc("rolling cart", "cart", [
    lp("top drawer", "drawer", []),
    lp("MFT drawer", "drawer", []),
    lp("hex drawer", "drawer", []),
  ]),
  lc("wooden cabinets", "cabinet", []),
]);
const locations: InfLocationConfig[] = [
  garage,
  lc("kitchen", "room", [
    lc("pantry", "cabinet", [
      lp("spice drawer", "drawer", []),
      lp("coffee drawer", "drawer", []),
    ]),

    lc("peninsula drawers", "cabinet", [
      lp("small dry goods", "drawer", []),
      lp("large dry goods", "drawer", []),
    ]),
  ]),
];
const products: ProductConfigItem[] = [
  i("White sugar", "015800030621", "C&H", [
    uvp(4, "lb", 3, "dollars", "whole foods"),
  ]),
  i("All Purpose Flour", "071012010509", "King Arthur", [
    uvp(5, "lb", 8, "dollars", "whole foods"),
    flourDensity,
  ]),
  i("All Purpose Flour", "039978533012", "Bob's Red Mill", [
    uvp(5, "lb", 7, "dollars", "whole foods"),
    flourDensity,
  ]),
  gi("pastry flour", [uvp(5, "lb", 8, "dollars", "whole foods"), flourDensity]),
  gi("cake flour", [uvp(5, "lb", 8, "dollars", "whole foods"), flourDensity]),
  gi("whole wheat flour", [
    uvp(5, "lb", 8, "dollars", "whole foods"),
    flourDensity,
  ]),
  gi("large brown eggs", [
    uvp(12, "whole", 7, "dollars", "whole foods"),
    uvp(1, "whole", 50, "grams", "general"),
  ]),
  i("large brown eggs", "815652004142", "Pete & Gerry's", []),

  gi("butter", [
    uvp(1, "stick", 113, "g", "whole foods"),
    uvp(4, "stick", 8, "dollars", "whole foods"),
  ]),
  gi("olive oil", [densityOil]),
  i("olive oil", "850687100339", "CA olive range", [
    uvp(15, "dollars", 500, "ml", "whole foods"),
  ]),
  gi("vegetable oil", [densityOil]),
  gi("canola oil", [densityOil]),
  gi("avocado oil", [densityOil]),
  gi("water", [densityWater]),
  gi("milk", [
    densityWater,
    uvp(0.5, "Quart", 3, "dollars", "general"),
    uvp(1, "Cup", 236.588, "ml", "TEST, should be part of unit/lib.rs"),
  ]),
  {
    name: "M18 Hackzall",
    upc: "045242502776",
    manufacturer: "Milwaukee",
    model: "2719-20",
    unit_mappings: [uvp(1, "each", 169, "dollars", "home depot")],
  },
];

export const config: DataConfig = {
  locations,
  products,
  aliases,
};
