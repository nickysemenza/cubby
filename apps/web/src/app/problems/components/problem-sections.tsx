import type { Entity } from "@cubby/schemas/entity";
import type { AllProblems } from "@cubby/schemas/problems";
import { Link } from "@tanstack/react-router";
import { groupBy } from "es-toolkit";
import {
  Download,
  ImageOff,
  type LucideIcon,
  Network,
  Sparkles,
  Wrench,
} from "lucide-react";
import type { ReactNode } from "react";
import { useProblemCardMutation } from "~/app/_components/hooks/useProblemCardMutation";
import { formatAmounts } from "~/app/_components/inventory/format-amount";
import { DriftIndicator } from "~/app/_components/parse-drift-indicator";
import { DecompositionView } from "~/app/_components/recipe/decomposition-view";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { EntityIcon } from "~/entities/entities";
import { queryKeys } from "~/lib/query-keys";
import { formatCurrency } from "~/lib/utils";
import type { ProductWithBetterUpcData } from "~/server/repo/problems";
import { useTRPC } from "~/trpc/react";
import { BACKFILL } from "./backfill-registry";
import { EmptyLocationsList } from "./empty-locations-list";
import {
  AliasPruneFix,
  DeleteAllUnusedButton,
  RemoveAllAliasesButton,
  UnusedIngredientDeleteFix,
} from "./ingredient-cleanup-fixes";
import { BackfillButton } from "./problem-backfill-action";
import {
  type IconProp,
  ProblemSection,
  type RenderedProblemItem,
} from "./problem-section";
import { byManufacturer, CodeChip, createdAgoDetail } from "./render-helpers";
import { OrphanedDeleteFix } from "./tier2-fixes";
import {
  buildUnitCoverageItems,
  CoverageChips,
  UnitCoverageInlineFix,
  type UnitCoverageItem,
  unitCoverageGroup,
} from "./unit-coverage-fix";

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
  /** A static "fix all" node, or one built from the current items (for bulk delete). */
  headerAction?: ReactNode | ((items: T[]) => ReactNode);
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
          headerAction={
            typeof config.headerAction === "function"
              ? config.headerAction(items)
              : config.headerAction
          }
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

/**
 * "Apply" action for the "Better UPC data available" cards — writes the
 * looked-up fields onto the product in place (manufacturer/price via update +
 * recipe recompute, image via R2 import) without leaving the page. Lives in a
 * component (not `renderItem`) so it can own the mutation hook; the card drops
 * out of the list once the problems queries invalidate.
 */
function UpcApplyAction({ product }: { product: ProductWithBetterUpcData }) {
  const api = useTRPC();
  const apply = useProblemCardMutation({
    mutationFn: api.product.applyUpcData.mutationOptions,
    success: `Updated ${product.name} from UPC`,
    // The whole problems.* path is always invalidated by the hook (which also
    // feeds the navbar badge count); add the product/recipe lists (price feeds
    // cost).
    invalidateKeys: [queryKeys.product.all, queryKeys.recipe.list],
  });
  return (
    <Button
      size="sm"
      onClick={() => apply.mutate({ id: product.id, upc: product.upc })}
      disabled={apply.isPending}
    >
      <Download className="mr-1 h-3 w-3" />
      {apply.isPending ? "Applying…" : "Apply"}
    </Button>
  );
}

/** Card for the merged "Unit coverage" section — core-4 chips + the inline fix. */
/**
 * "Fix in workbench" action — the ingredient-enrichment workbench is the one
 * place to link USDA / set price / add conversions / merge (the Problems page no
 * longer hosts a second, worse inline editor for that). Deep-links to the exact
 * ingredient row via `?focus=` so a click lands ready to edit.
 */
function WorkbenchFixLink({ ingredientId }: { ingredientId: string | null }) {
  return (
    <Button
      size="sm"
      render={
        <Link
          to="/ingredients/workbench"
          search={ingredientId ? { focus: ingredientId } : {}}
        />
      }
      nativeButton={false}
    >
      <Wrench className="mr-1 h-3 w-3" />
      Fix in workbench
    </Button>
  );
}

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

  if (item.kind === "partial") {
    // Ingredient enrichment → the workbench (not a second inline editor).
    return {
      ...base,
      customActions: <WorkbenchFixLink ingredientId={item.ingredientId} />,
      details: [
        <CoverageChips
          key="cov"
          covered={item.coverage.covered}
          applicable={item.coverage.applicable}
          usdaLinked={item.hasUsdaLink}
        />,
      ],
    };
  }

  if (item.kind === "none" && item.isIngredient) {
    // Bare ingredient product → the workbench creates/links it properly.
    return {
      ...base,
      customActions: <WorkbenchFixLink ingredientId={item.ingredientId} />,
      badges: [
        <Badge key="none" variant="outline" className="w-fit">
          No conversions
        </Badge>,
      ],
      details: [<CoverageChips key="cov" covered={[]} />],
    };
  }

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

  // Remaining: `none` and not an ingredient — a non-food product that just needs
  // a price. Keep the lightweight inline PriceFix.
  return {
    ...base,
    inlineFix: inlineFix("Set price"),
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
    id: "no-product-ingredients",
    label: "No product",
    select: (p) => p.ingredientsWithoutProduct,
    entity: "ingredient",
    title: "Ingredients without a product",
    description:
      "Ingredients used in recipes but not linked to any product, so they can't be costed. Link a product (ideally with a USDA food) to each.",
    emptyMessage: "Every recipe ingredient is linked to a product.",
    renderItem: (ing) => ({
      title: ing.name,
      details: [
        `Used in ${ing.recipeCount} recipe${ing.recipeCount === 1 ? "" : "s"}`,
      ],
      route: { to: "/ingredients/$id", params: { id: ing.id } },
      // The workbench can actually create the product; the detail page can't.
      customActions: <WorkbenchFixLink ingredientId={ing.id} />,
    }),
  }),
  section({
    id: "unused-aliases",
    label: "Unused aliases",
    select: (p) => p.ingredientsWithUnusedAliases,
    entity: "ingredient",
    title: "Ingredients with unused aliases",
    description:
      "Aliases that duplicate the ingredient's name (or each other), or that no recipe line ever matches. Removing an alias leaves the ingredient untouched.",
    emptyMessage: "No unused aliases — every alias is doing something.",
    headerAction: (items) => (
      <RemoveAllAliasesButton
        rows={items.map((i) => ({ id: i.id, unusedAliases: i.unusedAliases }))}
      />
    ),
    renderItem: (ing) => ({
      title: ing.name,
      badges: ing.unusedAliases.map((alias) => (
        <Badge key={alias} variant="outline">
          {alias}
        </Badge>
      )),
      route: { to: "/ingredients/$id", params: { id: ing.id } },
      inlineFix: {
        label: "Remove aliases",
        render: (close) => (
          <AliasPruneFix
            id={ing.id}
            name={ing.name}
            unusedAliases={ing.unusedAliases}
            close={close}
          />
        ),
      },
    }),
  }),
  section({
    id: "unused-with-product",
    label: "Unused (has product)",
    select: (p) => p.unusedIngredientsWithProduct,
    entity: "ingredient",
    title: "Unused ingredients linked to a product",
    description:
      "Ingredients used in no recipe but still linked to a product. Deleting removes the ingredient and its product(s) — skipped if a product still has inventory.",
    emptyMessage: "No unused product-linked ingredients.",
    headerAction: (items) => (
      <DeleteAllUnusedButton ids={items.map((i) => i.id)} alsoDeleteProducts />
    ),
    renderItem: (ing) => ({
      title: ing.name,
      details: [createdAgoDetail(ing.createdAt)],
      badges: ing.products.map((prod) => (
        <Link key={prod.id} to="/products/$id" params={{ id: prod.id }}>
          <Badge
            variant="outline"
            className="flex items-center gap-1 hover:bg-accent"
          >
            <EntityIcon entity="product" colored className="h-3 w-3" />
            {prod.name}
          </Badge>
        </Link>
      )),
      route: { to: "/ingredients/$id", params: { id: ing.id } },
      inlineFix: {
        label: "Delete + product(s)",
        render: (close) => (
          <UnusedIngredientDeleteFix
            id={ing.id}
            name={ing.name}
            alsoDeleteProducts
            close={close}
          />
        ),
      },
    }),
  }),
  section({
    id: "unused-no-product",
    label: "Unused",
    select: (p) => p.unusedIngredientsWithoutProduct,
    entity: "ingredient",
    title: "Unused ingredients",
    description:
      "Ingredients used in no recipe and linked to no product — safe to delete.",
    emptyMessage: "No unused ingredients.",
    headerAction: (items) => (
      <DeleteAllUnusedButton
        ids={items.map((i) => i.id)}
        alsoDeleteProducts={false}
      />
    ),
    renderItem: (ing) => ({
      title: ing.name,
      details: [createdAgoDetail(ing.createdAt)],
      route: { to: "/ingredients/$id", params: { id: ing.id } },
      inlineFix: {
        label: "Delete",
        render: (close) => (
          <UnusedIngredientDeleteFix
            id={ing.id}
            name={ing.name}
            alsoDeleteProducts={false}
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
    headerAction: <BackfillButton {...BACKFILL.fetchUpcImages} />,
    renderItem: (product) => ({
      title: product.name,
      subtitle: byManufacturer(product.manufacturer),
      badges: product.upc ? [<CodeChip key="upc">{product.upc}</CodeChip>] : [],
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
    headerAction: <BackfillButton {...BACKFILL.analyzeDescriptions} />,
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
    headerAction: <BackfillButton {...BACKFILL.reparse} />,
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
          className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-xs"
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
    id: "upc-updates",
    label: "UPC Updates",
    select: (p) => p.productsWithBetterUpcData ?? [],
    icon: Download,
    title: "Better UPC data available",
    description:
      "A fresh UPC lookup can fill in these missing fields. Apply to write the new value onto the product.",
    emptyMessage: "No products have newer info available from UPC lookup.",
    renderItem: (product) => {
      const { proposed } = product;
      // Show the actual value a fresh lookup would write per field — not just
      // which fields are missing — so it's clear what "Apply" changes.
      const details: ReactNode[] = [];
      if (proposed.manufacturer != null) {
        details.push(
          <div key="manufacturer" className="text-sm">
            <span className="text-muted-foreground">Manufacturer → </span>
            <span className="font-medium">{proposed.manufacturer}</span>
          </div>,
        );
      }
      if (proposed.price != null) {
        details.push(
          <div key="price" className="text-sm">
            <span className="text-muted-foreground">Price → </span>
            <span className="font-medium">
              {formatCurrency(proposed.price)}
            </span>
          </div>,
        );
      }
      return {
        title: product.name,
        subtitle: byManufacturer(product.manufacturer),
        imageSlot: proposed.imageUrl ? (
          <img
            src={proposed.imageUrl}
            alt={`${product.name} (from UPC lookup)`}
            className="h-full w-full object-cover"
            // UPC-sourced image URLs can 404; degrade to an empty slot (the
            // "New image" badge still conveys the gap) instead of sprawling alt.
            onError={(e) => {
              e.currentTarget.style.display = "none";
            }}
          />
        ) : undefined,
        details,
        badges: [
          ...(proposed.imageUrl
            ? [
                <Badge key="image" variant="secondary">
                  New image
                </Badge>,
              ]
            : []),
          <CodeChip key="upc">{product.upc}</CodeChip>,
        ],
        route: { to: "/products/$id", params: { id: product.id } },
        editLabel: "Open product",
        customActions: <UpcApplyAction product={product} />,
      };
    },
  }),
];
