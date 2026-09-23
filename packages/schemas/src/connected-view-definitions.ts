import type { Entity } from "./entity";

export interface ConnectedView {
  key: string;
  title: string;
  target: Entity;
  /** Each route follows named, directional manifest relationships. */
  routes: readonly (readonly string[])[];
}

/**
 * The indirect tables worth reading on a record. Every entity has an explicit
 * entry, including entities whose useful connections are already direct or
 * whose relationships are external. Paths through a shared vendor, purchase,
 * or project into unrelated sibling records are intentionally absent.
 */
export const connectedViews = {
  product: [
    {
      key: "recipes",
      title: "Recipes",
      target: "recipe",
      routes: [["ingredient", "recipes"]],
    },
  ],
  recipe: [
    {
      key: "products",
      title: "Ingredient products",
      target: "product",
      routes: [["ingredients", "products"]],
    },
    {
      key: "inventory",
      title: "Ingredient stock",
      target: "inventory",
      routes: [["ingredients", "products", "inventory"]],
    },
    {
      key: "purchases",
      title: "Ingredient purchases",
      target: "purchase",
      routes: [["ingredients", "products", "purchases"]],
    },
  ],
  ingredient: [
    {
      key: "inventory",
      title: "Stock",
      target: "inventory",
      routes: [["products", "inventory"]],
    },
    {
      key: "purchases",
      title: "Purchases",
      target: "purchase",
      routes: [["products", "purchases"]],
    },
    {
      key: "expenses",
      title: "Expense history",
      target: "expense",
      routes: [["products", "expenses"]],
    },
    {
      key: "vendors",
      title: "Vendors",
      target: "vendor",
      routes: [["products", "vendors"]],
    },
    {
      key: "locations",
      title: "Stocked locations",
      target: "location",
      routes: [["products", "locations"]],
    },
  ],
  cookbook: [
    {
      key: "ingredients",
      title: "Ingredients",
      target: "ingredient",
      routes: [["recipes", "ingredients"]],
    },
    {
      key: "meals",
      title: "Meals",
      target: "meal",
      routes: [["recipes", "meals"]],
    },
    {
      key: "products",
      title: "Ingredient products",
      target: "product",
      routes: [["recipes", "ingredients", "products"]],
    },
  ],
  location: [
    {
      key: "products",
      title: "Stored products",
      target: "product",
      routes: [["inventory", "product"]],
    },
    {
      key: "purchases",
      title: "Stored product purchases",
      target: "purchase",
      routes: [["inventory", "product", "purchases"]],
    },
    {
      key: "expenses",
      title: "Stored product expenses",
      target: "expense",
      routes: [["inventory", "product", "expenses"]],
    },
    {
      key: "plants",
      title: "Plants",
      target: "plant",
      routes: [["plantings", "plant"]],
    },
    {
      key: "tasks",
      title: "Planting tasks",
      target: "task",
      routes: [["plantings", "task"]],
    },
    {
      key: "projects",
      title: "Planting projects",
      target: "project",
      routes: [["plantings", "task", "project"]],
    },
  ],
  inventory: [
    {
      key: "purchases",
      title: "Purchases",
      target: "purchase",
      routes: [["product", "purchases"]],
    },
    {
      key: "expenses",
      title: "Expense history",
      target: "expense",
      routes: [["product", "expenses"]],
    },
    {
      key: "tasks",
      title: "Product tasks",
      target: "task",
      routes: [["product", "tasks"]],
    },
    {
      key: "projects",
      title: "Purchased for projects",
      target: "project",
      routes: [["product", "purchased-projects"]],
    },
    {
      key: "vendors",
      title: "Vendors",
      target: "vendor",
      routes: [["product", "vendors"]],
    },
    {
      key: "meals",
      title: "Meals",
      target: "meal",
      routes: [["product", "meals"]],
    },
    {
      key: "plant",
      title: "Plant",
      target: "plant",
      routes: [["product", "grows-plant"]],
    },
  ],
  meal: [
    {
      key: "purchases",
      title: "Food purchases",
      target: "purchase",
      routes: [["food-products", "purchases"]],
    },
    {
      key: "ingredients",
      title: "Recipe ingredients",
      target: "ingredient",
      routes: [["recipes", "ingredients"]],
    },
  ],
  ledgerParty: [
    {
      key: "products",
      title: "Owned or used products",
      target: "product",
      routes: [
        ["inventory", "product"],
        ["meals", "food-products"],
        ["expenses", "product"],
      ],
    },
    {
      key: "purchases",
      title: "Expense purchases",
      target: "purchase",
      routes: [["expenses", "purchase"]],
    },
    {
      key: "projects",
      title: "Expense projects",
      target: "project",
      routes: [["expenses", "project"]],
    },
  ],
  ledgerTransfer: [
    {
      key: "purchases",
      title: "Evidence purchases",
      target: "purchase",
      routes: [["evidence-transactions", "purchase"]],
    },
  ],
  project: [
    {
      key: "plantings",
      title: "Task plantings",
      target: "planting",
      routes: [["tasks", "plantings"]],
    },
    {
      key: "plants",
      title: "Task plants",
      target: "plant",
      routes: [["tasks", "plantings", "plant"]],
    },
    {
      key: "garden-entries",
      title: "Task garden entries",
      target: "gardenEntry",
      routes: [["tasks", "plantings", "entries"]],
    },
    {
      key: "transactions",
      title: "Expense transactions",
      target: "financialTransaction",
      routes: [["expenses", "transactions"]],
    },
  ],
  task: [
    {
      key: "purchases",
      title: "Subject purchases",
      target: "purchase",
      routes: [["subject", "purchases"]],
    },
    {
      key: "expenses",
      title: "Subject expenses",
      target: "expense",
      routes: [["subject", "expenses"]],
    },
    {
      key: "inventory",
      title: "Subject stock",
      target: "inventory",
      routes: [["subject", "inventory"]],
    },
    {
      key: "vendors",
      title: "Subject vendors",
      target: "vendor",
      routes: [["subject", "vendors"]],
    },
    {
      key: "plants",
      title: "Plants",
      target: "plant",
      routes: [["plantings", "plant"]],
    },
    {
      key: "garden-entries",
      title: "Garden entries",
      target: "gardenEntry",
      routes: [["plantings", "entries"]],
    },
  ],
  vendor: [
    {
      key: "inventory",
      title: "Stock from purchased products",
      target: "inventory",
      routes: [["products", "inventory"]],
    },
    {
      key: "plantings",
      title: "Plantings from purchased products",
      target: "planting",
      routes: [["products", "plantings"]],
    },
  ],
  purchase: [
    {
      key: "inventory",
      title: "Purchased product stock",
      target: "inventory",
      routes: [["products", "inventory"]],
    },
    {
      key: "tasks",
      title: "Purchased product tasks",
      target: "task",
      routes: [["products", "tasks"]],
    },
    {
      key: "plantings",
      title: "Purchased product plantings",
      target: "planting",
      routes: [["products", "plantings"]],
    },
    {
      key: "plants",
      title: "Purchased plants",
      target: "plant",
      routes: [["products", "grows-plant"]],
    },
  ],
  financialAccount: [
    {
      key: "expenses",
      title: "Settlement expenses",
      target: "expense",
      routes: [["transactions", "expenses"]],
    },
    {
      key: "products",
      title: "Settlement products",
      target: "product",
      routes: [["transactions", "products"]],
    },
    {
      key: "projects",
      title: "Settlement projects",
      target: "project",
      routes: [
        ["transactions", "purchase", "projects"],
        ["transactions", "expenses", "project"],
      ],
    },
  ],
  financialTransaction: [
    {
      key: "projects",
      title: "Projects",
      target: "project",
      routes: [
        ["purchase", "projects"],
        ["expenses", "project"],
      ],
    },
  ],
  wish: [
    {
      key: "purchases",
      title: "Candidate purchases",
      target: "purchase",
      routes: [["candidates", "purchases"]],
    },
    {
      key: "inventory",
      title: "Candidate stock",
      target: "inventory",
      routes: [["candidates", "inventory"]],
    },
    {
      key: "vendors",
      title: "Candidate vendors",
      target: "vendor",
      routes: [["candidates", "vendors"]],
    },
  ],
  expense: [
    {
      key: "inventory",
      title: "Product stock",
      target: "inventory",
      routes: [["product", "inventory"]],
    },
    {
      key: "plantings",
      title: "Product plantings",
      target: "planting",
      routes: [["product", "plantings"]],
    },
    {
      key: "plant",
      title: "Plant",
      target: "plant",
      routes: [["product", "grows-plant"]],
    },
    {
      key: "vendor",
      title: "Purchase vendor",
      target: "vendor",
      routes: [["purchase", "vendor"]],
    },
  ],
  "usda-food": [],
  image: [
    {
      key: "reporting-devices",
      title: "Reporting devices",
      target: "device",
      routes: [["sightings", "reporter"]],
    },
  ],
  planting: [
    {
      key: "products",
      title: "Cultivar products",
      target: "product",
      routes: [["plant", "products"]],
    },
    {
      key: "purchases",
      title: "Source purchases",
      target: "purchase",
      routes: [["source-product", "purchases"]],
    },
    {
      key: "expenses",
      title: "Source expenses",
      target: "expense",
      routes: [["source-product", "expenses"]],
    },
    {
      key: "project",
      title: "Task project",
      target: "project",
      routes: [["task", "project"]],
    },
    {
      key: "ingredient",
      title: "Plant ingredient",
      target: "ingredient",
      routes: [["plant", "ingredient"]],
    },
  ],
  gardenEntry: [
    {
      key: "plants",
      title: "Plants",
      target: "plant",
      routes: [["plantings", "plant"]],
    },
    {
      key: "products",
      title: "Planting products",
      target: "product",
      routes: [["plantings", "source-product"]],
    },
    {
      key: "tasks",
      title: "Planting tasks",
      target: "task",
      routes: [["plantings", "task"]],
    },
    {
      key: "projects",
      title: "Planting projects",
      target: "project",
      routes: [["plantings", "task", "project"]],
    },
    {
      key: "purchases",
      title: "Planting product purchases",
      target: "purchase",
      routes: [["plantings", "source-product", "purchases"]],
    },
  ],
  vendorAccount: [
    {
      key: "products",
      title: "Purchased products",
      target: "product",
      routes: [["purchases", "products"]],
    },
    {
      key: "expenses",
      title: "Expenses",
      target: "expense",
      routes: [["purchases", "expenses"]],
    },
    {
      key: "projects",
      title: "Projects",
      target: "project",
      routes: [["purchases", "projects"]],
    },
  ],
  productCategory: [
    {
      key: "inventory",
      title: "Product stock",
      target: "inventory",
      routes: [["products", "inventory"]],
    },
    {
      key: "purchases",
      title: "Product purchases",
      target: "purchase",
      routes: [["products", "purchases"]],
    },
    {
      key: "expenses",
      title: "Product expenses",
      target: "expense",
      routes: [["products", "expenses"]],
    },
    {
      key: "tasks",
      title: "Product tasks",
      target: "task",
      routes: [["products", "tasks"]],
    },
    {
      key: "projects",
      title: "Purchased projects",
      target: "project",
      routes: [["products", "purchased-projects"]],
    },
    {
      key: "vendors",
      title: "Product vendors",
      target: "vendor",
      routes: [["products", "vendors"]],
    },
  ],
  importRun: [
    {
      key: "products",
      title: "Imported products",
      target: "product",
      routes: [["purchases", "products"]],
    },
    {
      key: "expenses",
      title: "Imported expenses",
      target: "expense",
      routes: [["purchases", "expenses"]],
    },
    {
      key: "projects",
      title: "Imported projects",
      target: "project",
      routes: [["purchases", "projects"]],
    },
  ],
  device: [
    {
      key: "images",
      title: "Sighting images",
      target: "image",
      routes: [["image-sightings", "image"]],
    },
    {
      key: "owners",
      title: "Sighting owners",
      target: "ledgerParty",
      routes: [["image-sightings", "owner"]],
    },
  ],
  imageSighting: [
    {
      key: "captured-by",
      title: "Image captured by",
      target: "ledgerParty",
      routes: [["image", "captured-by"]],
    },
    {
      key: "reporter-owner",
      title: "Reporter owner",
      target: "ledgerParty",
      routes: [["reporter", "owner"]],
    },
  ],
  plant: [
    {
      key: "purchases",
      title: "Purchases",
      target: "purchase",
      routes: [["products", "purchases"]],
    },
    {
      key: "expenses",
      title: "Expense history",
      target: "expense",
      routes: [["products", "expenses"]],
    },
    {
      key: "inventory",
      title: "Seed and plant stock",
      target: "inventory",
      routes: [["products", "inventory"]],
    },
    {
      key: "locations",
      title: "Stocked locations",
      target: "location",
      routes: [["products", "locations"]],
    },
    {
      key: "vendors",
      title: "Vendors",
      target: "vendor",
      routes: [["products", "vendors"]],
    },
    {
      key: "tasks",
      title: "Tasks",
      target: "task",
      routes: [
        ["products", "tasks"],
        ["plantings", "task"],
      ],
    },
    {
      key: "projects",
      title: "Projects",
      target: "project",
      routes: [
        ["products", "purchased-projects"],
        ["products", "tasks", "project"],
        ["plantings", "task", "project"],
      ],
    },
    {
      key: "garden-entries",
      title: "Garden entries",
      target: "gardenEntry",
      routes: [["plantings", "entries"]],
    },
    {
      key: "recipes",
      title: "Recipes",
      target: "recipe",
      routes: [["ingredient", "recipes"]],
    },
    {
      key: "meals",
      title: "Meals",
      target: "meal",
      routes: [["ingredient", "meals"]],
    },
  ],
} as const satisfies Record<Entity, readonly ConnectedView[]>;

export type ConnectedViewKey<E extends Entity = Entity> =
  (typeof connectedViews)[E][number]["key"];
