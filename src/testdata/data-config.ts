import { Amount } from "~/codec/codec";
import { Config, InfLocationConfig, ProductConfigItem } from "~/schemas/config";
import { UnitMapping } from "~/schemas/ingredient";
import { InfLocation } from "~/schemas/locations";

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

const densityOil = uvp(1, "ml", 0.9, "g", "unk");
const densityWater = uvp(1, "ml", 1, "g", "unk");
const flourDensity = uvp(1, "cup", 120, "g", "unk");

const garage: InfLocationConfig = {
  name: "garage",
  type: "room",
  children: [
    {
      name: "toolbag",
      type: "bag",
      products: [
        p("Packout toolbag", "045242505296", "Milwaukee", "48-22-8315", 99),
      ],
    },
    {
      name: "chrome wire shelf",
      type: "shelf",
      children: [
        {
          name: "oscillating and grinder",
          type: "half-crate",
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
        {
          name: "bin B",
          type: "crate",
        },
        {
          name: "bin C",
          type: "crate",
        },
      ],
    },
    {
      name: "black wire shelf",
      type: "shelf",
    },
    {
      name: "white metal shelf",
      type: "shelf",
    },
    {
      name: "packout wall",
      type: "shelf",
    },
    {
      name: "butcher block workbench",
      type: "table",
    },
    {
      name: "rolling cart",
      type: "cart",
      children: [
        {
          name: "top drawer",
          type: "drawer",
        },
        {
          name: "MFT drawer",
          type: "drawer",
        },
        {
          name: "hex drawer",
          type: "drawer",
        },
      ],
    },
    {
      name: "wooden cabinets",
      type: "cabinet",
    },
  ],
};

export const config: Config = {
  locations: [
    garage,
    {
      name: "kitchen",
      type: "room",
      children: [
        {
          name: "pantry",
          type: "cabinet",
          children: [
            {
              name: "spice drawer",
              type: "drawer",
            },
            {
              name: "coffee drawer",
              type: "drawer",
            },
          ],
        },
        {
          name: "peninsula drawers",
          type: "cabinet",
          children: [
            {
              name: "small dry goods",
              type: "drawer",
            },
            {
              name: "large dry goods",
              type: "drawer",
            },
          ],
        },
      ],
    },
  ],
  products: [
    i("White sugar", "015800030621", "C&H", [
      uvp(4, "lb", 3, "dollars", "whole foods"),
    ]),
    i("All Purpose Flour", "071012010509", "King Arthur", [
      uvp(5, "lb", 8, "dollars", "whole foods"),
    ]),
    i("All Purpose Flour", "039978533012", "Bob's Red Mill", [
      uvp(5, "lb", 7, "dollars", "whole foods"),
    ]),
    gi("large brown eggs", [
      uvp(12, "whole", 7, "dollars", "whole foods"),
      uvp(1, "whole", 50, "grams", "general"),
    ]),
    gi("butter", [
      uvp(1, "stick", 113, "g", "whole foods"),
      uvp(4, "stick", 8, "dollars", "whole foods"),
    ]),
    gi("olive oil", [densityOil]), //todo: alises here
    gi("vegetable oil", [densityOil]),
    gi("canola oil", [densityOil]),
    gi("avocado oil", [densityOil]),
    {
      name: "M18 Hackzall",
      upc: "045242502776",
      manufacturer: "Milwaukee",
      model: "2719-20",
      unit_mappings: [uvp(1, "each", 169, "dollars", "home depot")],
    },
  ],
};
