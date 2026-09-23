import {
  type BrowserRoutedEntity,
  browserRoutedEntities,
} from "@cubby/schemas/entity-manifest";
import {
  WAYFINDING_DOMAINS,
  entitySummary,
} from "@cubby/schemas/entity-summary";
import type { LinkProps } from "@tanstack/react-router";
import {
  ArrowLeftRight,
  BookOpenCheck,
  CalendarRange,
  Camera,
  ChefHat,
  CircleDollarSign,
  ClipboardCheck,
  CreditCard,
  ListChecks,
  PackageSearch,
  PanelsTopLeft,
  QrCode,
  ScanBarcode,
  ShoppingCart,
  Sparkles,
  Sprout,
  Warehouse,
  Wrench,
} from "lucide-react";

import { entities } from "~/entities/entities";

import {
  DOMAIN_WAYFINDING,
  domainForEntity,
  type WayfindingDomain,
} from "./domain-wayfinding";

/** A route selected by a declarative application view. */
export interface ApplicationDestination {
  readonly to: LinkProps["to"];
  readonly label: string;
  readonly description: string;
  readonly icon: React.ComponentType<{ className?: string }>;
}

/** A household activity family. Domain order is the shell's reading order. */
export interface ActivityViewDefinition {
  readonly key: WayfindingDomain;
  readonly label: string;
  readonly icon: React.ComponentType<{ className?: string }>;
  readonly destinations: readonly ApplicationDestination[];
}

/** A direct roster/detail entry point backed by one entity declaration. */
export interface RecordViewDefinition extends ApplicationDestination {
  readonly entity: BrowserRoutedEntity;
  readonly domain: WayfindingDomain;
}

const recordDestination = (
  entity: BrowserRoutedEntity,
  description: string,
): ApplicationDestination => ({
  to: entities[entity].routes.list,
  label: entities[entity].pluralLabel,
  description,
  icon: entities[entity].lucideIcon,
});

/**
 * Task-shaped destinations. Specialist workbenches stay specialist: this
 * declaration only places and describes them; their route owns its UI.
 */
export const activityViews = [
  {
    key: "cook",
    label: DOMAIN_WAYFINDING.cook.label,
    icon: ChefHat,
    destinations: [
      recordDestination("recipe", "Browse recipes and open one to cook."),
      recordDestination("cookbook", "Browse the recipe collections you keep."),
      {
        to: "/ingredients/workbench",
        label: "Ingredient workbench",
        description: "Resolve ingredient identity and measurement coverage.",
        icon: ListChecks,
      },
      {
        to: "/ingredients/equivalences",
        label: "Ingredient equivalences",
        description: "Review conversion paths between ingredient units.",
        icon: ArrowLeftRight,
      },
      {
        to: "/recipes/compare",
        label: "Compare recipes",
        description: "Compare ingredients, portions, and costs side by side.",
        icon: PanelsTopLeft,
      },
      {
        to: "/recipes/import",
        label: "Import recipes",
        description: "Bring recipes into Cubby with a supervised review.",
        icon: BookOpenCheck,
      },
    ],
  },
  {
    key: "pantry",
    label: DOMAIN_WAYFINDING.pantry.label,
    icon: Warehouse,
    destinations: [
      recordDestination("inventory", "Review what is currently on hand."),
      recordDestination("location", "Browse the places where things live."),
      {
        to: "/scan",
        label: "Scan a product",
        description: "Find or receive a product from its barcode.",
        icon: ScanBarcode,
      },
      {
        to: "/inventory/session",
        label: "Recount inventory",
        description: "Restore the household's approximate on-hand picture.",
        icon: ClipboardCheck,
      },
      {
        to: "/inventory/bulk-move",
        label: "Move inventory",
        description: "Relocate several inventory records together.",
        icon: PackageSearch,
      },
      {
        to: "/locations/photo-pass",
        label: "Location photo pass",
        description:
          "Capture useful location photos while moving around the house.",
        icon: Camera,
      },
      {
        to: "/locations/arrange",
        label: "Arrange locations",
        description: "Maintain the physical location hierarchy.",
        icon: Warehouse,
      },
      {
        to: "/pantry-view",
        label: "Pantry view",
        description: "Explore stocked products in their physical context.",
        icon: PackageSearch,
      },
      {
        to: "/labels",
        label: "Print labels",
        description: "Prepare durable labels for household locations.",
        icon: QrCode,
      },
    ],
  },
  {
    key: "plan",
    label: DOMAIN_WAYFINDING.plan.label,
    icon: CalendarRange,
    destinations: [
      recordDestination("meal", "Review meals planned for upcoming days."),
      recordDestination("wish", "Keep track of items you may want to buy."),
      {
        to: "/calendar",
        label: "Household calendar",
        description: "Plan meals, tasks, and expected expenses by date.",
        icon: CalendarRange,
      },
      {
        to: "/meals/suggestions",
        label: "What can I make?",
        description: "Find recipes supported by approximate availability.",
        icon: Sparkles,
      },
      {
        to: "/meals/shopping-list",
        label: "Build a shopping list",
        description: "Turn selected meals into reviewed shopping needs.",
        icon: ShoppingCart,
      },
    ],
  },
  {
    key: "house",
    label: DOMAIN_WAYFINDING.house.label,
    icon: Wrench,
    destinations: [
      recordDestination(
        "project",
        "Open household work grouped into projects.",
      ),
      recordDestination("task", "Review concrete work and completion state."),
      recordDestination(
        "planting",
        "Record plantings, photos, harvests, and plans for your growing areas.",
      ),
      {
        to: "/garden-workbench",
        label: "Garden workbench",
        description: "Compare planting timing, household practice, and plans.",
        icon: Sprout,
      },
      {
        to: "/tools",
        label: "Tool coverage",
        description: "See which reusable tools support household work.",
        icon: Wrench,
      },
      {
        to: "/projects/tools",
        label: "Project tools",
        description: "Connect project plans to the tools they require.",
        icon: PackageSearch,
      },
    ],
  },
  {
    key: "finance",
    label: DOMAIN_WAYFINDING.finance.label,
    icon: CreditCard,
    destinations: [
      recordDestination("expense", "Review the authoritative household spend."),
      recordDestination("purchase", "Review orders and their expense lines."),
      {
        to: "/household-contribution",
        label: "Contribution ledger",
        description: "Review shared costs and household positions.",
        icon: ArrowLeftRight,
      },
      {
        to: "/statement-rows",
        label: "Reconcile statements",
        description: "Match imported statement evidence to recorded purchases.",
        icon: CircleDollarSign,
      },
    ],
  },
] as const satisfies readonly ActivityViewDefinition[];

/**
 * Images have a Records destination but intentionally no route wayfinding
 * (`presentation.domain: null`); the catalog files them under Pantry.
 */
const recordDomain = (entity: BrowserRoutedEntity): WayfindingDomain =>
  domainForEntity(entity) ?? "pantry";

const recordView = (entity: BrowserRoutedEntity): RecordViewDefinition => ({
  entity,
  domain: recordDomain(entity),
  to: entities[entity].routes.list,
  label: entities[entity].pluralLabel,
  description: entitySummary[entity].description,
  icon: entities[entity].lucideIcon,
});

/**
 * Every browser-routed entity appears exactly once in the Records catalog,
 * grouped by wayfinding line in shell order and, within a line, in
 * declaration order. Copy and grouping come from each declaration's
 * `presentation`; nothing here is per-entity.
 */
export const recordViews: readonly RecordViewDefinition[] =
  WAYFINDING_DOMAINS.flatMap((domain) =>
    browserRoutedEntities
      .filter((entity) => recordDomain(entity) === domain)
      .map(recordView),
  );

export function recordViewFor(
  entity: BrowserRoutedEntity,
): RecordViewDefinition {
  const definition = recordViews.find((view) => view.entity === entity);
  if (!definition) throw new Error(`Record view ${entity} is missing`);
  return definition;
}
