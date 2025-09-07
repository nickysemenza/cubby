import {
  InfLocationConfigInput,
  ProductConfigItemInput,
  DataConfig,
} from "~/schemas/config";
import {
  locationWithChildren,
  locationWithProducts,
  product,
  genericProduct,
  productIngredient,
  productGenericIngredient,
  productReference,
  locationWithProductReferences,
} from "./data-helpers";

const densityOil = "1 ml = 0.9g @ unk";
const densityWater = "1 ml = 1g @ unk";
const flourDensity = "1 cup = 120g @ unk";
const spiceJarPrice = "2 oz = $8 @ whole foods";

const garage: InfLocationConfigInput = locationWithChildren("garage", "room", [
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
const locations: InfLocationConfigInput[] = [
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
  productIngredient(
    "White sugar",
    "015800030621",
    "C&H",
    ["4 lb = $5 @ whole foods", "4 lb = 1each @ general"],
    ["sugar", "granulated sugar"],
  ),
  productGenericIngredient(
    "powdered sugar",
    19336,
    ["2 lb = $5 @ whole foods"],
    ["confectioner's sugar", "confectioners sugar"],
  ),
];
const flours = [
  productIngredient(
    "All Purpose Flour",
    "071012010509",
    "King Arthur",
    ["5 lb = $8 @ whole foods", flourDensity],
    ["AP flour", "flour", "white flour", "all-purpose flour"],
  ),
  productIngredient(
    "All Purpose Flour",
    "039978533012",
    "Bob's Red Mill",
    ["5 lb = $7 @ whole foods", flourDensity],
    ["AP flour", "flour", "white flour", "all-purpose flour"],
  ),
  productIngredient("pastry flour", "075211436504", "generic", [
    "5 lb = $8 @ whole foods",
    flourDensity,
  ]),
  productGenericIngredient("cake flour", 20084, [
    "5 lb = $8 @ whole foods",
    flourDensity,
  ]),
  productGenericIngredient("whole wheat flour", 20649, [
    "5 lb = $8 @ whole foods",
    flourDensity,
  ]),
];

const dairy = [
  productGenericIngredient(
    "large brown eggs",
    1123,
    ["12 whole = $7 @ whole foods", "1 whole = 50grams @ general"],
    ["eggs", "large egg", "large eggs", "egg", "large brown egg"],
  ),
  productIngredient(
    "large brown eggs",
    "815652004142",
    "Pete & Gerry's",
    undefined,
    ["eggs", "large egg", "large eggs", "egg", "large brown egg"],
  ),

  productGenericIngredient(
    "butter",
    1145,
    ["1 stick = 113g @ whole foods", "4 stick = $8 @ whole foods"],
    ["unsalted butter"],
  ),
  productGenericIngredient("milk", 1077, [
    densityWater,
    "0.5 Quart = $3 @ general",
    "1 Cup = 236.588ml @ TEST, should be part of unit/lib.rs",
  ]),
];

const oil = [
  productGenericIngredient(
    "olive oil",
    4053,
    [densityOil, "2 liter = $23 @ costco"],
    ["Extra Virgin Olive Oil", "evoo"],
  ),
  productIngredient(
    "olive oil",
    "850687100339",
    "CA olive range",
    ["15 dollars = 500ml @ whole foods"],
    ["Extra Virgin Olive Oil", "evoo"],
  ),

  productGenericIngredient("vegetable oil", 44005, [
    densityOil,
    "1 liter = $6 @ whole foods",
  ]),
  productGenericIngredient("canola oil", 4582, [
    densityOil,
    "1 liter = $6 @ whole foods",
  ]),
  productGenericIngredient("avocado oil", 4581, [
    densityOil,
    "2 liter = $23 @ costco",
  ]),
];

const spices = [
  productIngredient(
    "kosher salt",
    "013600020019",
    "Diamond Crystal",
    ["3 lb = $8 @ whole foods"],
    ["salt"],
  ),
  {
    ...productIngredient("baking soda", "033200011408", "Arm & Hammer", [
      "10 oz = $3 @ whole foods",
      "1 cup = 520.49grams @ google search",
    ]),
    ndb_number: 18372, //redundant
  },
  {
    ...productIngredient("baking powder", "019900003202", "Clabber Girl", [
      "10 oz = $3 @ whole foods",
    ]),
    ndb_number: 18369, //redundant
  },
  productGenericIngredient("ginger", 11216, ["1 lb = $4 @ safeway"]),
  productGenericIngredient("ground ginger", 2021, [spiceJarPrice]),
  productGenericIngredient("ground cinnamon", 2010, [spiceJarPrice]),
  productGenericIngredient("nutmeg", 2025, [spiceJarPrice]),
  productGenericIngredient(
    "black pepper",
    2030,
    ["2 oz = $8 @ whole foods", "1 tsp = 1tsp, ground @ tmp"],
    ["pepper"],
  ),
];
const produce = [
  productGenericIngredient("cilantro", 11165, [
    "1 bunch = $2 @ whole foods",
    "1 bunch = 100sprig @ general",
    "1 bunch = 1each @ general",
  ]),
];
const baking = [
  productGenericIngredient("molasses", 19304, [spiceJarPrice]),
  productGenericIngredient("vanilla extract", 2050, [spiceJarPrice]),
];
const products: ProductConfigItemInput[] = [
  ...sugars,
  ...flours,
  ...dairy,
  ...oil,
  productGenericIngredient("water", 14411, [
    densityWater,
    "11968 cups = $11.4 @ sf puc",
  ]),
  ...spices,
  ...produce,
  ...baking,

  productGenericIngredient("salsa", 6164, ["2 cups = $6 @ whole foods"]),
  product("M18 Hackzall", "045242502776", "Milwaukee", "2719-20", 169),
];

export const config: DataConfig = {
  locations,
  products,
};

console.log(JSON.stringify(config, null, 2));
