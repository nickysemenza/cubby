import { Amount } from "~/codec/codec";
import { Config, InfLocationConfig, ProductConfigItem } from "~/schemas/config";
import { UnitMapping } from "~/schemas/ingredient";

const uv = (value: number, unit: string): Amount => ({ unit, value });
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
const gp = (name: string): ProductConfigItem => ({
  name,
  manufacturer: "generic",
});
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

const gi = (name: string, unit_mappings: UnitMapping[]): ProductConfigItem => ({
  name,
  ingredient: true,
  manufacturer: "generic",
  unit_mappings,
});

const l = (name: string, type: string) => ({
  name,
  type,
});

const densityOil = uvp(1, "ml", 0.9, "g", "unk");
const densityWater = uvp(1, "ml", 1, "g", "unk");
const flourDensity = uvp(1, "cup", 120, "g", "unk");

export const aliases: Record<string, string[]> = {
  "all purpose flour": ["AP flour", "flour", "white flour"],
  "olive oil": ["Extra Virgin Olive Oil", "evoo"],
  egg: [
    "eggs",
    "large egg",
    "large eggs",
    "large brown eggs",
    "large brown egg",
  ],
};

const garage: InfLocationConfig = {
  ...l("garage", "room"),
  children: [
    {
      ...l("toolbag", "bag"),
      products: [
        p("Packout toolbag", "045242505296", "Milwaukee", "48-22-8315", 99),
      ],
    },
    {
      ...l("chrome wire shelf", "shelf"),
      children: [
        {
          ...l("oscillating and grinder", "half-crate"),
          products: [
            p("Ryobi Angle Grinder", "033287188048", "Ryobi", "PBLAG01B", 129),
            p(
              "Ryobi Oscillating Tool",
              "033287190706",
              "Ryobi",
              "PBLMT50B",
              129,
            ),
            gp("angle grinder discs"),
            gp("oscillating toolblades"),
          ],
        },
        l("bin B", "crate"),
        l("bin C", "crate"),
      ],
    },
    {
      ...l("black wire shelf", "shelf"),
    },
    {
      ...l("white metal shelf", "shelf"),
    },
    {
      ...l("packout wall", "shelf"),
    },
    {
      ...l("butcher block workbench", "table"),
    },
    {
      ...l("rolling cart", "cart"),
      children: [
        {
          ...l("top drawer", "drawer"),
        },
        {
          ...l("MFT drawer", "drawer"),
        },
        {
          ...l("hex drawer", "drawer"),
        },
      ],
    },
    {
      ...l("wooden cabinets", "cabinet"),
    },
  ],
};
const locations: InfLocationConfig[] = [
  garage,
  {
    ...l("kitchen", "room"),
    children: [
      {
        ...l("pantry", "cabinet"),
        children: [l("spice drawer", "drawer"), l("coffee drawer", "drawer")],
      },
      {
        ...l("peninsula drawers", "cabinet"),
        children: [
          l("small dry goods", "drawer"),
          l("large dry goods", "drawer"),
        ],
      },
    ],
  },
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
  gi("butter", [
    uvp(1, "stick", 113, "g", "whole foods"),
    uvp(4, "stick", 8, "dollars", "whole foods"),
  ]),
  gi("olive oil", [densityOil]),
  gi("vegetable oil", [densityOil]),
  gi("canola oil", [densityOil]),
  gi("avocado oil", [densityOil]),
  gi("water", [densityWater]),
  {
    name: "M18 Hackzall",
    upc: "045242502776",
    manufacturer: "Milwaukee",
    model: "2719-20",
    unit_mappings: [uvp(1, "each", 169, "dollars", "home depot")],
  },
];

export const config: Config = {
  locations,
  products,
  aliases,
};
