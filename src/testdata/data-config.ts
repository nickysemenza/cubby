import {
  InfLocationConfig,
  ProductConfigItem,
  DataConfig,
} from "~/schemas/config";
import { uvp, lc, lp, p, gp, i, gi } from "./data-helpers";

const densityOil = uvp(1, "ml", 0.9, "g", "unk");
const densityWater = uvp(1, "ml", 1, "g", "unk");
const flourDensity = uvp(1, "cup", 120, "g", "unk");
const spiceJarPrice = uvp(2, "oz", 8, "dollars", "whole foods");

export const aliases: Record<string, string[]> = {
  "all purpose flour": [
    "AP flour",
    "flour",
    "white flour",
    "all-purpose flour",
  ],
  "white sugar": ["sugar", "granulated sugar"],
  "powdered sugar": ["confectioner's sugar", "confectioners sugar"],
  "olive oil": ["Extra Virgin Olive Oil", "evoo"],
  butter: ["unsalted butter"],
  salt: ["kosher salt"],
  "large brown eggs": [
    "eggs",
    "large egg",
    "large eggs",
    "egg",
    "large brown egg",
  ],
  "black pepper": ["pepper"],
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
const sugars = [
  i("White sugar", "015800030621", "C&H", [
    uvp(4, "lb", 5, "dollars", "whole foods"),
  ]),
  gi("powdered sugar", 19336, [uvp(2, "lb", 5, "dollars", "whole foods")]),
];
const flours = [
  i("All Purpose Flour", "071012010509", "King Arthur", [
    uvp(5, "lb", 8, "dollars", "whole foods"),
    flourDensity,
  ]),
  i("All Purpose Flour", "039978533012", "Bob's Red Mill", [
    uvp(5, "lb", 7, "dollars", "whole foods"),
    flourDensity,
  ]),
  i("pastry flour", "075211436504", "generic", [
    uvp(5, "lb", 8, "dollars", "whole foods"),
    flourDensity,
  ]),
  gi("cake flour", 20084, [
    uvp(5, "lb", 8, "dollars", "whole foods"),
    flourDensity,
  ]),
  gi("whole wheat flour", 20649, [
    uvp(5, "lb", 8, "dollars", "whole foods"),
    flourDensity,
  ]),
];

const dairy = [
  gi("large brown eggs", 1123, [
    uvp(12, "whole", 7, "dollars", "whole foods"),
    uvp(1, "whole", 50, "grams", "general"),
  ]),
  i("large brown eggs", "815652004142", "Pete & Gerry's", []),

  gi("butter", 1145, [
    uvp(1, "stick", 113, "g", "whole foods"),
    uvp(4, "stick", 8, "dollars", "whole foods"),
  ]),
  gi("milk", 1077, [
    densityWater,
    uvp(0.5, "Quart", 3, "dollars", "general"),
    uvp(1, "Cup", 236.588, "ml", "TEST, should be part of unit/lib.rs"),
  ]),
];

const oil = [
  gi("olive oil", 4053, [densityOil, uvp(2, "liter", 23, "dollars", "costco")]),
  i("olive oil", "850687100339", "CA olive range", [
    uvp(15, "dollars", 500, "ml", "whole foods"),
  ]),

  gi("vegetable oil", 44005, [
    densityOil,
    uvp(1, "liter", 6, "dollars", "whole foods"),
  ]),
  gi("canola oil", 4582, [
    densityOil,
    uvp(1, "liter", 6, "dollars", "whole foods"),
  ]),
  gi("avocado oil", 4581, [
    densityOil,
    uvp(2, "liter", 23, "dollars", "costco"),
  ]),
];

const spices = [
  i("kosher salt", "013600020019", "Diamond Crystal", [
    uvp(3, "lb", 8, "dollars", "whole foods"),
  ]),
  {
    ...i("baking soda", "033200011408", "Arm & Hammer", [
      uvp(10, "oz", 3, "dollars", "whole foods"),
      uvp(1, "cup", 520.49, "grams", "google search"),
    ]),
    ndb_number: 18372, //redundant
  },
  {
    ...i("baking powder", "019900003202", "Clabber Girl", [
      uvp(10, "oz", 3, "dollars", "whole foods"),
    ]),
    ndb_number: 18369, //redundant
  },
  gi("ginger", 11216, [uvp(1, "lb", 4, "dollars", "safeway")]),
  gi("ground ginger", 2021, [spiceJarPrice]),
  gi("ground cinnamon", 2010, [spiceJarPrice]),
  gi("nutmeg", 2025, [spiceJarPrice]),
  gi("black pepper", 2030, [
    uvp(2, "oz", 8, "dollars", "whole foods"),
    uvp(1, "tsp", 1, "tsp, ground", "tmp"),
  ]),
];
const produce = [
  gi("cilantro", 11165, [
    uvp(1, "bunch", 2, "dollars", "whole foods"),
    uvp(1, "bunch", 100, "sprig", "general"),
  ]),
];
const baking = [
  gi("molasses", 19304, [spiceJarPrice]),
  gi("vanilla extract", 2050, [spiceJarPrice]),
];
const products: ProductConfigItem[] = [
  ...sugars,
  ...flours,
  ...dairy,
  ...oil,
  gi("water", 14411, [
    densityWater,
    uvp(11968, "cups", 11.4, "dollars", "sf puc"),
  ]),
  ...spices,
  ...produce,
  ...baking,

  gi("salsa", 6164, [uvp(2, "cups", 6, "dollars", "whole foods")]),

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
