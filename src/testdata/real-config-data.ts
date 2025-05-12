import {
  InfLocationConfig,
  ProductConfigItem,
  DataConfig,
} from "~/schemas/config";
import {
  uvp,
  locationWithChildren,
  locationWithProducts,
  product,
  genericProduct,
  productIngredient,
  productGenericIngredient,
  productReference,
  locationWithProductReferences,
} from "./data-helpers";

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

const garage: InfLocationConfig = locationWithChildren("garage", "room", [
  locationWithProducts("toolbag", "bag", [
    product("Packout toolbag", "045242505296", "Milwaukee", "48-22-8315", 99),
  ]),
  locationWithChildren("chrome wire shelf", "shelf", [
    locationWithProducts("oscillating and grinder", "half-crate", [
      product("Ryobi Angle Grinder", "033287188048", "Ryobi", "PBLAG01B", 129),
      product(
        "Ryobi Oscillating Tool",
        "033287190706",
        "Ryobi",
        "PBLMT50B",
        129,
      ),
      genericProduct("angle grinder discs", 4),
      genericProduct("oscillating toolblades", 8),
    ]),

    locationWithProducts("bin B", "crate"),
    locationWithProducts("bin C", "crate"),
  ]),
  locationWithChildren("black wire shelf", "shelf"),
  locationWithChildren("white metal shelf", "shelf"),
  locationWithChildren("packout wall", "shelf"),
  locationWithChildren("butcher block workbench", "table"),
  locationWithChildren("rolling cart", "cart", [
    locationWithProducts("top drawer", "drawer"),
    locationWithProducts("MFT drawer", "drawer"),
    locationWithProducts("hex drawer", "drawer"),
  ]),
  locationWithChildren("wooden cabinets", "cabinet"),
]);
const locations: InfLocationConfig[] = [
  garage,
  locationWithChildren("kitchen", "room", [
    locationWithChildren("kitchen", "room", [
      locationWithProductReferences("fridge", "cabinet", [
        productReference("cilantro"),
        productReference("white sugar"),
      ]),
    ]),

    locationWithChildren("pantry", "cabinet", [
      locationWithProducts("spice drawer", "drawer"),
      locationWithProducts("coffee drawer", "drawer"),
    ]),

    locationWithChildren("peninsula drawers", "cabinet", [
      locationWithProducts("small dry goods", "drawer"),
      locationWithProducts("large dry goods", "drawer"),
    ]),
  ]),
];
const sugars = [
  productIngredient("White sugar", "015800030621", "C&H", [
    uvp(4, "lb", 5, "dollars", "whole foods"),
    uvp(4, "lb", 1, "each", "general"),
  ]),
  productGenericIngredient("powdered sugar", 19336, [
    uvp(2, "lb", 5, "dollars", "whole foods"),
  ]),
];
const flours = [
  productIngredient("All Purpose Flour", "071012010509", "King Arthur", [
    uvp(5, "lb", 8, "dollars", "whole foods"),
    flourDensity,
  ]),
  productIngredient("All Purpose Flour", "039978533012", "Bob's Red Mill", [
    uvp(5, "lb", 7, "dollars", "whole foods"),
    flourDensity,
  ]),
  productIngredient("pastry flour", "075211436504", "generic", [
    uvp(5, "lb", 8, "dollars", "whole foods"),
    flourDensity,
  ]),
  productGenericIngredient("cake flour", 20084, [
    uvp(5, "lb", 8, "dollars", "whole foods"),
    flourDensity,
  ]),
  productGenericIngredient("whole wheat flour", 20649, [
    uvp(5, "lb", 8, "dollars", "whole foods"),
    flourDensity,
  ]),
];

const dairy = [
  productGenericIngredient("large brown eggs", 1123, [
    uvp(12, "whole", 7, "dollars", "whole foods"),
    uvp(1, "whole", 50, "grams", "general"),
  ]),
  productIngredient("large brown eggs", "815652004142", "Pete & Gerry's"),

  productGenericIngredient("butter", 1145, [
    uvp(1, "stick", 113, "g", "whole foods"),
    uvp(4, "stick", 8, "dollars", "whole foods"),
  ]),
  productGenericIngredient("milk", 1077, [
    densityWater,
    uvp(0.5, "Quart", 3, "dollars", "general"),
    uvp(1, "Cup", 236.588, "ml", "TEST, should be part of unit/lib.rs"),
  ]),
];

const oil = [
  productGenericIngredient("olive oil", 4053, [
    densityOil,
    uvp(2, "liter", 23, "dollars", "costco"),
  ]),
  productIngredient("olive oil", "850687100339", "CA olive range", [
    uvp(15, "dollars", 500, "ml", "whole foods"),
  ]),

  productGenericIngredient("vegetable oil", 44005, [
    densityOil,
    uvp(1, "liter", 6, "dollars", "whole foods"),
  ]),
  productGenericIngredient("canola oil", 4582, [
    densityOil,
    uvp(1, "liter", 6, "dollars", "whole foods"),
  ]),
  productGenericIngredient("avocado oil", 4581, [
    densityOil,
    uvp(2, "liter", 23, "dollars", "costco"),
  ]),
];

const spices = [
  productIngredient("kosher salt", "013600020019", "Diamond Crystal", [
    uvp(3, "lb", 8, "dollars", "whole foods"),
  ]),
  {
    ...productIngredient("baking soda", "033200011408", "Arm & Hammer", [
      uvp(10, "oz", 3, "dollars", "whole foods"),
      uvp(1, "cup", 520.49, "grams", "google search"),
    ]),
    ndb_number: 18372, //redundant
  },
  {
    ...productIngredient("baking powder", "019900003202", "Clabber Girl", [
      uvp(10, "oz", 3, "dollars", "whole foods"),
    ]),
    ndb_number: 18369, //redundant
  },
  productGenericIngredient("ginger", 11216, [
    uvp(1, "lb", 4, "dollars", "safeway"),
  ]),
  productGenericIngredient("ground ginger", 2021, [spiceJarPrice]),
  productGenericIngredient("ground cinnamon", 2010, [spiceJarPrice]),
  productGenericIngredient("nutmeg", 2025, [spiceJarPrice]),
  productGenericIngredient("black pepper", 2030, [
    uvp(2, "oz", 8, "dollars", "whole foods"),
    uvp(1, "tsp", 1, "tsp, ground", "tmp"),
  ]),
];
const produce = [
  productGenericIngredient("cilantro", 11165, [
    uvp(1, "bunch", 2, "dollars", "whole foods"),
    uvp(1, "bunch", 100, "sprig", "general"),
    uvp(1, "bunch", 1, "each", "general"),
  ]),
];
const baking = [
  productGenericIngredient("molasses", 19304, [spiceJarPrice]),
  productGenericIngredient("vanilla extract", 2050, [spiceJarPrice]),
];
const products: ProductConfigItem[] = [
  ...sugars,
  ...flours,
  ...dairy,
  ...oil,
  productGenericIngredient("water", 14411, [
    densityWater,
    uvp(11968, "cups", 11.4, "dollars", "sf puc"),
  ]),
  ...spices,
  ...produce,
  ...baking,

  productGenericIngredient("salsa", 6164, [
    uvp(2, "cups", 6, "dollars", "whole foods"),
  ]),
  product("M18 Hackzall", "045242502776", "Milwaukee", "2719-20", 169),
];

export const config: DataConfig = {
  locations,
  products,
  aliases,
};

console.log(JSON.stringify(config, null, 2));
