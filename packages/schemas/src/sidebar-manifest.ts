import type { BrowserRoutedEntity } from "./entity-manifest";
import type { WayfindingDomain } from "./entity-definitions/definition";

/** Entity glyphs come from the catalog; specialist routes declare their Apple glyph. */
export type SidebarDestination = {
  readonly label: string;
  readonly route: string;
} & (
  | { readonly entity: BrowserRoutedEntity; readonly sfSymbol?: never }
  | { readonly entity?: never; readonly sfSymbol: string }
);
export type SidebarSection = {
  readonly id: string;
  /** Empty only for the unheaded top block. */
  readonly label: string;
  readonly domain: WayfindingDomain | null;
  readonly defaultFolded: boolean;
  readonly destinations: readonly SidebarDestination[];
};

/** The ordered sidebar information architecture shared by web and generated Swift. */
export const SIDEBAR_SECTIONS = [
  {
    id: "top",
    label: "",
    domain: null,
    defaultFolded: false,
    destinations: [
      {
        label: "Home",
        route: "/",
        sfSymbol: "house",
      },
      {
        label: "Activity",
        route: "/activity",
        sfSymbol: "waveform.path.ecg",
      },
      {
        label: "Work queue",
        route: "/work-queue",
        sfSymbol: "checklist",
      },
      {
        label: "Problems",
        route: "/problems",
        sfSymbol: "exclamationmark.triangle",
      },
    ],
  },
  {
    id: "plan",
    label: "Plan",
    domain: "plan",
    defaultFolded: false,
    destinations: [
      {
        label: "Calendar",
        route: "/calendar",
        sfSymbol: "calendar",
      },
      {
        label: "Meals",
        route: "/meals",
        entity: "meal",
      },
      {
        label: "What can I make?",
        route: "/meals/suggestions",
        sfSymbol: "sparkles",
      },
      {
        label: "Shopping list",
        route: "/meals/shopping-list",
        sfSymbol: "cart",
      },
    ],
  },
  {
    id: "cook",
    label: "Cook",
    domain: "cook",
    defaultFolded: false,
    destinations: [
      {
        label: "Recipes",
        route: "/recipes",
        entity: "recipe",
      },
      {
        label: "Cookbooks",
        route: "/cookbooks",
        entity: "cookbook",
      },
      {
        label: "Ingredients",
        route: "/ingredients",
        entity: "ingredient",
      },
      {
        label: "Ingredient workbench",
        route: "/ingredients/workbench",
        sfSymbol: "checklist",
      },
      {
        label: "Equivalences",
        route: "/ingredients/equivalences",
        sfSymbol: "arrow.left.arrow.right",
      },
      {
        label: "Compare recipes",
        route: "/recipes/compare",
        sfSymbol: "rectangle.split.2x1",
      },
      {
        label: "Import recipes",
        route: "/recipes/import",
        sfSymbol: "book",
      },
      {
        label: "USDA foods",
        route: "/usda",
        entity: "usda-food",
      },
    ],
  },
  {
    id: "pantry",
    label: "Pantry",
    domain: "pantry",
    defaultFolded: false,
    destinations: [
      {
        label: "Inventory",
        route: "/inventory",
        entity: "inventory",
      },
      {
        label: "Products",
        route: "/products",
        entity: "product",
      },
      {
        label: "Locations",
        route: "/locations",
        entity: "location",
      },
      {
        label: "Pantry view",
        route: "/pantry-view",
        sfSymbol: "shippingbox",
      },
      {
        label: "Shelf triage",
        route: "/inventory/triage",
        sfSymbol: "checklist",
      },
      {
        label: "Arrange locations",
        route: "/locations/arrange",
        sfSymbol: "building.2",
      },
      {
        label: "Categories",
        route: "/product-categories",
        entity: "productCategory",
      },
      {
        label: "Labels",
        route: "/labels",
        sfSymbol: "qrcode",
      },
    ],
  },
  {
    id: "garden",
    label: "Garden",
    domain: "garden",
    defaultFolded: false,
    destinations: [
      {
        label: "Overview",
        route: "/garden-workbench",
        sfSymbol: "leaf",
      },
      {
        label: "Plantings",
        route: "/plantings",
        entity: "planting",
      },
      {
        label: "Plants",
        route: "/plants",
        entity: "plant",
      },
      {
        label: "Garden log",
        route: "/garden-entries",
        entity: "gardenEntry",
      },
    ],
  },
  {
    id: "house",
    label: "House",
    domain: "house",
    defaultFolded: false,
    destinations: [
      {
        label: "Projects",
        route: "/projects",
        entity: "project",
      },
      {
        label: "Tasks",
        route: "/tasks",
        entity: "task",
      },
      {
        label: "Tool coverage",
        route: "/tools",
        sfSymbol: "wrench.and.screwdriver",
      },
    ],
  },
  {
    id: "purchases",
    label: "Purchases",
    domain: "purchases",
    defaultFolded: false,
    destinations: [
      {
        label: "Purchases",
        route: "/purchases",
        entity: "purchase",
      },
      {
        label: "Wishes",
        route: "/wishes",
        entity: "wish",
      },
      {
        label: "Shipments",
        route: "/shipments",
        entity: "shipment",
      },
      {
        label: "Emails",
        route: "/emails",
        entity: "email",
      },
      {
        label: "Vendors",
        route: "/vendors",
        entity: "vendor",
      },
      {
        label: "Vendor accounts",
        route: "/vendor-accounts",
        entity: "vendorAccount",
      },
    ],
  },
  {
    id: "finance",
    label: "Finance",
    domain: "finance",
    defaultFolded: false,
    destinations: [
      {
        label: "Expenses",
        route: "/expenses",
        entity: "expense",
      },
      {
        label: "Cash flow",
        route: "/cash-flow",
        sfSymbol: "chart.xyaxis.line",
      },
      {
        label: "Contributions",
        route: "/household-contribution",
        sfSymbol: "arrow.left.arrow.right",
      },
      {
        label: "Accounts",
        route: "/financial-accounts",
        entity: "financialAccount",
      },
      {
        label: "Transactions",
        route: "/financial-transactions",
        entity: "financialTransaction",
      },
      {
        label: "Evidence",
        route: "/source-transaction-records",
        entity: "sourceTransactionRecord",
      },
      {
        label: "Imports",
        route: "/transaction-imports",
        entity: "transactionImport",
      },
      {
        label: "Categories",
        route: "/spending-categories",
        entity: "spendingCategory",
      },
      {
        label: "People",
        route: "/ledger-parties",
        entity: "ledgerParty",
      },
      {
        label: "Transfers",
        route: "/ledger-transfers",
        entity: "ledgerTransfer",
      },
    ],
  },
  {
    id: "records",
    label: "Records",
    domain: null,
    defaultFolded: false,
    destinations: [
      {
        label: "Images",
        route: "/images",
        entity: "image",
      },
      {
        label: "Image jobs",
        route: "/image-jobs",
        entity: "imageJob",
      },
      {
        label: "Runs",
        route: "/runs",
        entity: "run",
      },
      { label: "Jobs", route: "/jobs", entity: "job" },
      {
        label: "Run types",
        route: "/runs/types",
        sfSymbol: "list.bullet",
      },
      {
        label: "Devices",
        route: "/devices",
        entity: "device",
      },
      {
        label: "Suggestions",
        route: "/suggestions",
        sfSymbol: "lightbulb",
      },
      {
        label: "Entity explorer",
        route: "/entities",
        sfSymbol: "point.3.connected.trianglepath.dotted",
      },
      {
        label: "Graph",
        route: "/graph",
        sfSymbol: "point.3.connected.trianglepath.dotted",
      },
    ],
  },
  {
    id: "dev",
    label: "Dev",
    domain: null,
    defaultFolded: true,
    destinations: [
      {
        label: "Design",
        route: "/design",
        sfSymbol: "paintpalette",
      },
      {
        label: "AI",
        route: "/ai",
        sfSymbol: "sparkles",
      },
      {
        label: "Search debug",
        route: "/search/debug",
        sfSymbol: "magnifyingglass",
      },
      {
        label: "MCP tools",
        route: "/mcp",
        sfSymbol: "puzzlepiece.extension",
      },
    ],
  },
] as const satisfies readonly SidebarSection[];
