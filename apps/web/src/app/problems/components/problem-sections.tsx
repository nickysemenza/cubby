import type { Entity } from "@cubby/schemas/entity";
import { Link } from "@tanstack/react-router";
import { groupBy } from "es-toolkit";
import {
  DollarSign,
  Download,
  ImageOff,
  type LucideIcon,
  Network,
  Sparkles,
  Utensils,
  Zap,
} from "lucide-react";
import type { ReactNode } from "react";
import { formatAmounts } from "~/app/_components/inventory/format-amount";
import { DriftIndicator } from "~/app/_components/parse-drift-indicator";
import { DecompositionView } from "~/app/_components/recipe/decomposition-view";
import { Badge } from "~/components/ui/badge";
import { EntityIcon } from "~/entities/entities";
import { formatCurrencyRange, formatNumberRange } from "~/lib/format-range";
import { formatCurrency } from "~/lib/utils";
import type { ProductWithBetterUpcData } from "~/server/repo/problems";
import type { RouterOutputs } from "~/trpc/react";
import { EmptyLocationsList } from "./empty-locations-list";
import { BackfillButton } from "./problem-backfill-action";
import {
  type IconProp,
  ProblemSection,
  type RenderedProblemItem,
} from "./problem-section";
import {
  byManufacturer,
  CodeChip,
  createdAgoDetail,
  locationDetail,
} from "./render-helpers";
import {
  InventoryAmountFix,
  OrphanedDeleteFix,
  ProductUpcFix,
} from "./tier2-fixes";
import {
  buildUnitCoverageItems,
  CoverageChips,
  UnitCoverageInlineFix,
  type UnitCoverageItem,
  unitCoverageGroup,
} from "./unit-coverage-fix";

type AllProblems = RouterOutputs["problems"]["getAllProblems"];

/** One row of the Problems page: its scroll anchor, summary-chip label, count, and card. */
type ProblemSectionEntry = {
  /** Scroll-anchor id; also the summary-chip key. */
  id: string;
  /** Short label shown on the summary chip. */
  label: string;
  /** Issue count, used to show/hide the summary chip. */
  count: (problems: AllProblems) => number;
  /** The section card. */
  node: (problems: AllProblems) => ReactNode;
};

/**
 * Declare a section from data: static `ProblemSection` props plus a `select`
 * (the single source for both the count and the rendered items) and a
 * `renderItem`. The element type flows from `select` into `renderItem` with no
 * annotations. `headerAction` is a `<BackfillButton>` for the "fix all" sections.
 */
function section<T>(config: {
  id: string;
  label: string;
  select: (problems: AllProblems) => readonly T[];
  title: string;
  description: string;
  emptyMessage: string;
  icon?: LucideIcon;
  entity?: Entity;
  renderItem: (item: T) => RenderedProblemItem;
  groupBy?: (items: T[]) => Record<string, T[]>;
  headerAction?: ReactNode;
}): ProblemSectionEntry {
  const iconProp: IconProp = config.entity
    ? { entity: config.entity }
    : { icon: config.icon as LucideIcon };
  return {
    id: config.id,
    label: config.label,
    count: (problems) => config.select(problems).length,
    node: (problems) => {
      const items = [...config.select(problems)];
      return (
        <ProblemSection
          {...iconProp}
          title={config.title}
          description={config.description}
          emptyMessage={config.emptyMessage}
          items={items}
          renderItem={config.renderItem}
          groupBy={config.groupBy}
          headerAction={config.headerAction}
        />
      );
    },
  };
}

/** Escape hatch for a section that needs its own component (e.g. section-level state). */
function customSection<T>(def: {
  id: string;
  label: string;
  select: (problems: AllProblems) => readonly T[];
  render: (items: T[]) => ReactNode;
}): ProblemSectionEntry {
  return {
    id: def.id,
    label: def.label,
    count: (problems) => def.select(problems).length,
    node: (problems) => def.render([...def.select(problems)]),
  };
}

const GAP_LABELS: Record<keyof ProductWithBetterUpcData["gaps"], string> = {
  manufacturer: "Manufacturer",
  price: "Price",
  image: "Image",
};

const INDICATOR_LABELS: Record<"ndb" | "ingredient", string> = {
  ndb: "Has NDB",
  ingredient: "Has Ingredient",
};

/** Card for the merged "Unit coverage" section — core-4 chips + the inline fix. */
function renderUnitCoverageItem(item: UnitCoverageItem): RenderedProblemItem {
  const base = {
    title: item.name,
    subtitle: byManufacturer(item.manufacturer),
    route: { to: "/products/$id" as const, params: { id: item.id } },
    editLabel: "Open product",
  };
  const inlineFix = (label: string) => ({
    label,
    render: (close: () => void) => (
      <UnitCoverageInlineFix item={item} close={close} />
    ),
  });

  if (item.kind === "islanded") {
    return {
      ...base,
      inlineFix: inlineFix("Add conversion"),
      badges: [
        <Badge key="islands" variant="destructive">
          {item.islandCount} groups
        </Badge>,
      ],
      details: [
        <CoverageChips key="cov" covered={item.coverage.covered} />,
        ...item.islands.map((island, i) => (
          <div
            key={island.exampleUnit}
            className="text-muted-foreground text-sm"
          >
            Group {i + 1}: {island.units.join(", ")}
          </div>
        )),
      ],
    };
  }

  if (item.kind === "partial") {
    return {
      ...base,
      inlineFix: inlineFix("Fix coverage"),
      badges: [
        <Badge key="partial" variant="outline" className="w-fit">
          Price only
        </Badge>,
      ],
      // Only `money` is reachable (priced, but no USDA link / mappings).
      details: [<CoverageChips key="cov" covered={["money"]} />],
    };
  }

  return {
    ...base,
    inlineFix: inlineFix(item.isIngredient ? "Fix coverage" : "Set price"),
    badges: [
      <Badge key="none" variant="outline" className="w-fit">
        No conversions
      </Badge>,
    ],
    details: [<CoverageChips key="cov" covered={[]} />],
  };
}

/**
 * The Problems page in declaration order — the summary chips and the section
 * list both derive from this, so adding a check is a single entry here.
 */
export const PROBLEM_SECTIONS: ProblemSectionEntry[] = [
  section({
    id: "duplicates",
    label: "Duplicates",
    select: (p) => p.duplicateUniqueProducts,
    entity: "product",
    title: "Duplicate Unique Products",
    description:
      "Products marked as unique (expectedQuantity=1) but found in multiple locations. These should be consolidated or have their expectedQuantity updated.",
    emptyMessage:
      "No duplicate unique products found. All products with expectedQuantity=1 are in single locations.",
    renderItem: (product) => ({
      title: product.name,
      subtitle: byManufacturer(product.manufacturer),
      badges: product.locations.map((location) => (
        <Link
          key={location.id}
          to="/locations/$id"
          params={{ id: location.id }}
        >
          <Badge
            variant="outline"
            className="flex items-center gap-1 hover:bg-accent"
          >
            <EntityIcon entity="location" colored className="h-3 w-3" />
            {location.name}
          </Badge>
        </Link>
      )),
      route: { to: "/products/$id", params: { id: product.id } },
    }),
  }),
  section({
    id: "orphaned",
    label: "Orphaned",
    select: (p) => p.orphanedProducts,
    entity: "product",
    title: "Orphaned Products",
    description:
      "Products with no inventory entries and not linked to any recipe ingredients. These may be unused and can potentially be deleted.",
    emptyMessage:
      "No orphaned products found. All products have inventory entries.",
    renderItem: (product) => ({
      title: product.name,
      subtitle: byManufacturer(product.manufacturer),
      details: [createdAgoDetail(product.createdAt)],
      route: { to: "/products/$id", params: { id: product.id } },
      inlineFix: {
        label: "Delete",
        render: (close) => (
          <OrphanedDeleteFix
            id={product.id}
            name={product.name}
            close={close}
          />
        ),
      },
    }),
  }),
  section({
    id: "upcs",
    label: "UPCs",
    select: (p) => p.invalidUPCs,
    icon: Zap,
    title: "Invalid UPCs",
    description: "Products with invalid UPC formats or duplicate UPC codes.",
    emptyMessage:
      "No invalid UPC codes found. All UPCs are properly formatted and unique.",
    groupBy: (items) =>
      groupBy(items, (item) =>
        item.issue === "invalid_format" ? "Invalid Format" : "Duplicate UPCs",
      ),
    renderItem: (product) => ({
      title: product.name,
      subtitle: byManufacturer(product.manufacturer),
      badges: [
        <Badge key="issue" variant="destructive">
          {product.issue === "invalid_format" ? "Invalid UPC" : "Duplicate UPC"}
        </Badge>,
        <CodeChip key="upc">{product.upc}</CodeChip>,
      ],
      route: { to: "/products/$id", params: { id: product.id } },
      editLabel: "Fix",
      inlineFix: {
        label: "Fix UPC",
        render: (close) => (
          <ProductUpcFix id={product.id} upc={product.upc} close={close} />
        ),
      },
    }),
  }),
  section({
    id: "unit-coverage",
    label: "Unit coverage",
    // Merge the "can't fully convert" problems — empty graph (no price/USDA/
    // mappings), priced-but-bare ingredient (money-only), and fragmented graph
    // (islands) — into one discriminated list.
    select: (p) =>
      buildUnitCoverageItems(
        p.productsWithoutMappings,
        p.ingredientsWithPartialCoverage,
        p.productsWithIslandedMappings,
      ),
    icon: Network,
    title: "Unit coverage",
    description:
      "Products that can't fully convert between their units (including to price). Link a USDA food, set a price, or bridge disconnected groups.",
    emptyMessage: "All products can fully convert between their units.",
    groupBy: (items) => groupBy(items, unitCoverageGroup),
    renderItem: renderUnitCoverageItem,
  }),
  section({
    id: "stale-valuations",
    label: "Stale Valuations",
    select: (p) => p.inventoryWithStaleValuations,
    icon: DollarSign,
    title: "Stale Inventory Valuations",
    description:
      "Inventory entries where the stored valuation doesn't match amount × product price.",
    emptyMessage: "All inventory valuations are in sync.",
    headerAction: (
      <BackfillButton
        selectMutation={(api) =>
          api.inventory.backfillInventoryValuations.mutationOptions
        }
        invalidateKeys={(api) => [api.inventory.list.queryKey()]}
        idleLabel="Sync All Valuations"
        pendingLabel="Syncing..."
        toastResult={(result) =>
          result.updated > 0
            ? {
                tone: "success",
                message: `Synced ${result.updated} inventory valuation${result.updated !== 1 ? "s" : ""}`,
              }
            : {
                tone: "info",
                message: "No inventory entries need valuation sync",
              }
        }
      />
    ),
    renderItem: (entry) => ({
      title: entry.productName,
      details: [locationDetail(entry.locationName)],
      badges: [
        <span key="valuations" className="text-muted-foreground text-sm">
          {entry.storedValuation !== null
            ? formatCurrency(entry.storedValuation)
            : "null"}{" "}
          →{" "}
          {entry.expectedValuation != null
            ? formatCurrency(entry.expectedValuation)
            : "null"}
        </span>,
      ],
      route: { to: "/inventory/$id", params: { id: entry.id } },
    }),
  }),
  section({
    id: "amounts",
    label: "Amounts",
    select: (p) => p.invalidInventoryAmounts,
    entity: "inventory",
    title: "Invalid Inventory Amounts",
    description:
      "Inventory entries with zero or negative amounts that should be fixed or removed.",
    emptyMessage: "All inventory entries have valid positive amounts.",
    groupBy: (items) =>
      groupBy(items, (item) =>
        item.issue === "zero" ? "Zero Amounts" : "Negative Amounts",
      ),
    renderItem: (entry) => ({
      title: entry.productName,
      details: [locationDetail(entry.locationName)],
      badges: [
        <Badge key="issue" variant="destructive">
          {entry.issue === "zero" ? "Zero Amount" : "Negative Amount"}
        </Badge>,
        <CodeChip key="amount">
          {entry.amount.value} {entry.amount.unit}
        </CodeChip>,
      ],
      route: { to: "/inventory/$id", params: { id: entry.id } },
      editLabel: "Fix",
      inlineFix: {
        label: "Fix amount",
        render: (close) => (
          <InventoryAmountFix
            id={entry.id}
            unit={entry.amount.unit}
            close={close}
          />
        ),
      },
    }),
  }),
  customSection({
    id: "locations",
    label: "Locations",
    select: (p) => p.emptyLocations,
    render: (items) => <EmptyLocationsList locations={items} />,
  }),
  section({
    id: "images",
    label: "Images",
    select: (p) => p.productsWithNoImages,
    icon: ImageOff,
    title: "Missing Images",
    description: "Products that don't have any images.",
    emptyMessage: "All products have images.",
    headerAction: (
      <BackfillButton
        selectMutation={(api) => api.product.backfillUPCImages.mutationOptions}
        invalidateKeys={(api) => [api.product.list.queryKey()]}
        idleLabel="Fetch UPC Images"
        pendingLabel="Fetching..."
        toastResult={(result) => {
          if (result.imported > 0) {
            return {
              tone: "success",
              message: `Imported ${result.imported} image${result.imported !== 1 ? "s" : ""}`,
            };
          }
          if (result.found === 0) {
            return { tone: "info", message: "No products need UPC images" };
          }
          return {
            tone: "info",
            message: `No images found for ${result.skipped} product(s)`,
          };
        }}
      />
    ),
    renderItem: (product) => ({
      title: product.name,
      subtitle: byManufacturer(product.manufacturer),
      badges: product.upc ? [<CodeChip key="upc">{product.upc}</CodeChip>] : [],
      route: { to: "/products/$id", params: { id: product.id } },
    }),
  }),
  section({
    id: "categories",
    label: "Categories",
    select: (p) => p.productsWithWrongCategory,
    icon: Utensils,
    title: "Wrong Category",
    description:
      "Products with food indicators (UPC, NDB, or ingredient link) but category is not set to 'food'.",
    emptyMessage: "All products with food indicators have correct categories.",
    headerAction: (
      <BackfillButton
        selectMutation={(api) =>
          api.product.backfillFoodCategories.mutationOptions
        }
        invalidateKeys={(api) => [api.product.list.queryKey()]}
        idleLabel="Fix All Categories"
        pendingLabel="Fixing..."
        toastResult={(result) =>
          result.updated > 0
            ? {
                tone: "success",
                message: `Updated ${result.updated} product${result.updated !== 1 ? "s" : ""} to food category`,
              }
            : { tone: "info", message: "No products need category update" }
        }
      />
    ),
    renderItem: (product) => ({
      title: product.name,
      subtitle: byManufacturer(product.manufacturer),
      badges: [
        <Badge key="category" variant="outline">
          {product.category ?? "No category"}
        </Badge>,
        <Badge key="indicator" variant="secondary">
          {INDICATOR_LABELS[product.indicator]}
        </Badge>,
      ],
      route: { to: "/products/$id", params: { id: product.id } },
    }),
  }),
  section({
    id: "ai-descriptions",
    label: "AI Descriptions",
    select: (p) => p.locationsWithoutAiDescription ?? [],
    icon: Sparkles,
    title: "Missing AI Descriptions",
    description:
      "Locations with photos that haven't been analyzed by AI yet. Run backfill to generate descriptions for all.",
    emptyMessage: "All locations with photos have AI descriptions.",
    headerAction: (
      <BackfillButton
        selectMutation={(api) =>
          api.ai.backfillLocationDescriptions.mutationOptions
        }
        idleLabel="Analyze All"
        pendingLabel="Analyzing..."
        toastResult={(result) =>
          result.analyzed > 0
            ? {
                tone: "success",
                message: `Analyzed ${result.analyzed} location${result.analyzed !== 1 ? "s" : ""}`,
              }
            : { tone: "info", message: "No locations need AI description" }
        }
      />
    ),
    renderItem: (location) => ({
      title: location.name,
      badges: [
        <Badge key="type" variant="outline" className="capitalize">
          {location.type}
        </Badge>,
        <Badge key="images" variant="secondary">
          {location.imageCount} {location.imageCount === 1 ? "photo" : "photos"}
        </Badge>,
      ],
      route: { to: "/locations/$id", params: { id: location.id } },
    }),
  }),
  section({
    id: "stale-parses",
    label: "Stale Parses",
    select: (p) => p.staleIngredientParses ?? [],
    entity: "recipe",
    title: "Stale Parses",
    description:
      "Ingredient lines whose original text, re-parsed with the current parser, would now differ from what's stored — on name, amounts, or modifier. Re-parsing would update them.",
    emptyMessage:
      "No stale parses — every stored ingredient matches a fresh parse of its original line.",
    headerAction: (
      <BackfillButton
        selectMutation={(api) => api.problems.reparseStale.mutationOptions}
        invalidateKeys={(api) => [api.recipe.list.queryKey()]}
        idleLabel="Re-parse All"
        pendingLabel="Re-parsing..."
        toastResult={(result) =>
          result.updated > 0
            ? {
                tone: "success",
                message: `Re-parsed ${result.updated} ingredient line${result.updated !== 1 ? "s" : ""}`,
              }
            : { tone: "info", message: "No stale parses to re-parse" }
        }
      />
    ),
    // Title is the stable ingredient name; every drifted axis (name included) is a
    // DriftIndicator in the details — the card title is string-typed, so a colored
    // diff can't live there.
    renderItem: (item) => ({
      // The same ingredient name can appear twice in one recipe, so key on the
      // row id rather than the default storedName-recipeId composite.
      key: item.recipeSectionIngredientId,
      title: item.storedName,
      subtitle: item.recipeName,
      details: [
        <div
          key="drifts"
          className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-xs"
        >
          {item.nameDrift && (
            <DriftIndicator
              axis="name"
              before={item.storedName}
              after={item.parsedName}
            />
          )}
          {item.amountDrift && (
            <DriftIndicator
              axis="amount"
              before={formatAmounts(item.storedAmounts)}
              after={formatAmounts(item.parsedAmounts)}
            />
          )}
          {item.modifierDrift && (
            <DriftIndicator
              axis="modifier"
              before={item.storedModifier ?? ""}
              after={item.parsedModifier ?? ""}
            />
          )}
        </div>,
        <div
          key="rawLine"
          className="flex flex-wrap items-baseline gap-x-1 text-muted-foreground/70 text-xs"
          title="How the current parser carves the original line"
        >
          <span className="italic">parsed from:</span>
          <DecompositionView rawLine={item.rawLine} />
        </div>,
      ],
      route: { to: "/recipes/$id", params: { id: item.recipeId } },
    }),
  }),
  section({
    id: "stale-totals",
    label: "Stale Totals",
    select: (p) => p.staleRecipeTotals ?? [],
    entity: "recipe",
    title: "Stale Totals",
    description:
      "Recipes whose persisted cost/calorie rollups are out of date — newly added, edited, or affected by a changed price or USDA enrichment. The list shows last-known figures; recomputing refreshes them.",
    emptyMessage:
      "No stale totals — every recipe's cost and calorie rollups are up to date.",
    headerAction: (
      // One batch covers the whole backlog at the max limit; the action is manual
      // (no background loop) so it never busy-polls. USDA-incomplete recipes may
      // stay stale and reappear — that's expected; recompute again once warm.
      <BackfillButton
        selectMutation={(api) => api.recipe.recomputeStale.mutationOptions}
        invalidateKeys={(api) => [api.recipe.list.queryKey()]}
        variables={{ limit: 500 }}
        idleLabel="Recompute All"
        pendingLabel="Recomputing..."
        toastResult={(result) =>
          result.processed > 0
            ? {
                tone: "success",
                message:
                  `Recomputed ${result.processed} recipe total${result.processed !== 1 ? "s" : ""}` +
                  (result.remaining > 0
                    ? ` — ${result.remaining} still awaiting data`
                    : ""),
              }
            : { tone: "info", message: "No stale totals to recompute" }
        }
      />
    ),
    renderItem: (item) => ({
      title: item.recipeName,
      subtitle: item.totals
        ? `${formatCurrencyRange(item.totals.costTotal, item.totals.costTotalUpper)} · ${formatNumberRange(item.totals.caloriesTotal, item.totals.caloriesTotalUpper, (n) => `${Math.round(n)}`)} cal`
        : "Not yet computed",
      route: { to: "/recipes/$id", params: { id: item.recipeId } },
    }),
  }),
  section({
    id: "upc-updates",
    label: "UPC Updates",
    select: (p) => p.productsWithBetterUpcData ?? [],
    icon: Download,
    title: "Better UPC data available",
    description:
      "A fresh UPC lookup can fill in missing fields on these products. Re-import to pull the newer info.",
    emptyMessage: "No products have newer info available from UPC lookup.",
    renderItem: (product) => ({
      title: product.name,
      subtitle: byManufacturer(product.manufacturer),
      badges: [
        ...(Object.keys(GAP_LABELS) as Array<keyof typeof GAP_LABELS>)
          .filter((key) => product.gaps[key])
          .map((key) => (
            <Badge key={key} variant="secondary">
              {GAP_LABELS[key]}
            </Badge>
          )),
        <CodeChip key="upc">{product.upc}</CodeChip>,
      ],
      route: { to: "/products/$id", params: { id: product.id } },
      editLabel: "Re-import",
    }),
  }),
];
