import type { Entity } from "@cubby/schemas/entity";
import { unsafeCookbookId } from "@cubby/schemas/identifiers";
import {
  type AllProblems,
  type LabelVariant,
  type ProductMissingPrice,
  TRACKER_PROBLEM_KEY_BY_TYPE,
} from "@cubby/schemas/problems";
import type {
  ProjectAttentionItem,
  ProjectAttentionType,
} from "@cubby/schemas/project";
import type { SearchableEntityRef } from "@cubby/schemas/search";
import { getMiscDisplayName } from "@cubby/shared";
import { Link } from "@tanstack/react-router";
import { groupBy } from "es-toolkit";
import {
  AlertTriangle,
  Download,
  ImageOff,
  ListFilter,
  type LucideIcon,
  Network,
  ScanBarcode,
  Sparkles,
  Wrench,
} from "lucide-react";
import type { ReactNode } from "react";
import { match } from "ts-pattern";
import { useProblemCardMutation } from "~/app/_components/hooks/useProblemCardMutation";
import { AuditedHint } from "~/app/inventory/session/_components/AuditedHint";
import { formatDate } from "~/app/projects/project-formatting";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { EntityIcon } from "~/entities/entities";
import { useTRPC } from "~/integrations/trpc/react";
import { productRecipeMutationInvalidateKeys } from "~/lib/query-keys";
import { formatCurrency } from "~/lib/utils";
import type { ProductWithBetterUpcData } from "~/server/repo/problems";
import { BACKFILL } from "./backfill-registry";
import { EmptyLocationsList } from "./empty-locations-list";
import {
  DeleteAllUnusedButton,
  UnusedIngredientDeleteFix,
} from "./ingredient-cleanup-fixes";
import { BackfillButton } from "./problem-backfill-action";
import {
  type IconProp,
  ProblemSection,
  type RenderedProblemItem,
} from "./problem-section";
import { byManufacturer, CodeChip, createdAgoDetail } from "./render-helpers";
import { OrderVendorBackfillFix, OrphanedDeleteFix } from "./tier2-fixes";
import {
  buildUnitCoverageItems,
  CoverageChips,
  UnitCoverageInlineFix,
  type UnitCoverageItem,
  unitCoverageGroup,
} from "./unit-coverage-fix";

/**
 * Sections tagged `autoFixable` are the ones the top-of-page Fix button fully
 * clears. They render inside a collapsed group at the bottom instead of the main
 * list: one click empties them, so they'd otherwise be prime real estate holding
 * rows nobody has to read. Untagged sections stay in the main list.
 */
type ProblemSectionGroup = "autoFixable";

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
  /** Collapsed-group membership; absent ⇒ the main list. */
  group?: ProblemSectionGroup;
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
  group?: ProblemSectionGroup;
}): ProblemSectionEntry {
  const iconProp: IconProp = config.entity
    ? { entity: config.entity }
    : { icon: config.icon as LucideIcon };
  return {
    id: config.id,
    label: config.label,
    group: config.group,
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
    invalidateKeys: productRecipeMutationInvalidateKeys,
  });
  return (
    <Button
      size="sm"
      onClick={() => apply.mutate({ id: product.id, upc: product.upc })}
      disabled={apply.isPending}
    >
      <Download className="mr-1 size-3" />
      {apply.isPending ? "Applying…" : "Apply"}
    </Button>
  );
}

function OrphanedEmbeddingCleanupFix({
  id,
  close,
}: {
  id: string;
  close: () => void;
}) {
  const api = useTRPC();
  const cleanup = useProblemCardMutation({
    mutationFn: api.problems.cleanupOrphanedEmbeddings.mutationOptions,
    success: "Cleaned up orphaned embedding",
    onSuccess: close,
  });
  return (
    <Button
      size="sm"
      onClick={() => cleanup.mutate({ ids: [id] })}
      disabled={cleanup.isPending}
    >
      <Wrench className="mr-1 size-3" />
      {cleanup.isPending ? "Cleaning…" : "Clean up"}
    </Button>
  );
}

/**
 * "Backfill all" for entities semantic search can't see yet. A plain mutation
 * (it only enqueues), so it uses the card-mutation hook rather than the
 * BackfillButton stream — but the work itself is durable, hence the link out to
 * the queue.
 */
function MissingEmbeddingsBackfillAction() {
  const api = useTRPC();
  const backfill = useProblemCardMutation({
    mutationFn: api.search.enqueueEmbeddingBackfill.mutationOptions,
    success: (data) =>
      data.totalJobs > 0
        ? `Queued ${data.totalJobs} for embedding.`
        : "Nothing to embed.",
  });
  return (
    <Button
      size="sm"
      onClick={() => backfill.mutate({})}
      disabled={backfill.isPending}
    >
      {backfill.isPending ? "Queuing…" : "Backfill all"}
    </Button>
  );
}

function searchableEntityRoute(entityRef: SearchableEntityRef) {
  return match(entityRef)
    .with({ entityType: "product" }, (e) => ({
      to: "/products/$id" as const,
      params: { id: e.entityId },
    }))
    .with({ entityType: "location" }, (e) => ({
      to: "/locations/$id" as const,
      params: { id: e.entityId },
    }))
    .with({ entityType: "ingredient" }, (e) => ({
      to: "/ingredients/$id" as const,
      params: { id: e.entityId },
    }))
    .with({ entityType: "recipe" }, (e) => ({
      to: "/recipes/$id" as const,
      params: { id: e.entityId },
    }))
    .with({ entityType: "cookbook" }, (e) => ({
      to: "/cookbooks/$cookbookId" as const,
      params: { cookbookId: unsafeCookbookId(e.entityId) },
    }))
    .with({ entityType: "inventory" }, (e) => ({
      to: "/inventory/$id" as const,
      params: { id: e.entityId },
    }))
    .with({ entityType: "meal" }, (e) => ({
      to: "/meals/$id" as const,
      params: { id: e.entityId },
    }))
    .with({ entityType: "project" }, (e) => ({
      to: "/projects/$id" as const,
      params: { id: e.entityId },
    }))
    .with({ entityType: "task" }, (e) => ({
      to: "/tasks/$id" as const,
      params: { id: e.entityId },
    }))
    .with({ entityType: "purchase" }, (e) => ({
      to: "/purchases/$id" as const,
      params: { id: e.entityId },
    }))
    .exhaustive();
}

/**
 * Household-tracker rules in display order (most actionable first) with each
 * rule's subsection title. The section merges the seven per-rule slices in
 * this order, then groups the merged list back by title — so the counts stay
 * first-class per detector (badge tooltip, MCP `type`) while the page shows one
 * "Tracker" card with a subsection per rule, like the unit-coverage merge.
 */
const TRACKER_GROUPS: { type: ProjectAttentionType; title: string }[] = [
  { type: "overdue_task", title: "Overdue tasks" },
  { type: "blocked_work", title: "Blocked with no next action" },
  { type: "stalled_project", title: "Stalled projects" },
  { type: "past_due_planned_purchase", title: "Planned purchases past due" },
  { type: "missing_budget", title: "Missing a cost estimate" },
  { type: "unclassified_purchase", title: "Unclassified purchases" },
  { type: "date_window_drift", title: "Date window drift" },
];

const TRACKER_GROUP_TITLE = Object.fromEntries(
  TRACKER_GROUPS.map((g) => [g.type, g.title]),
) as Record<ProjectAttentionType, string>;

const trackerRoute = (item: ProjectAttentionItem) =>
  match(item.entityType)
    .with("project", () => ({
      to: "/projects/$id" as const,
      params: { id: item.entityId },
    }))
    .with("task", () => ({
      to: "/tasks/$id" as const,
      params: { id: item.entityId },
    }))
    .with("purchase", () => ({
      to: "/purchases/$id" as const,
      params: { id: item.entityId },
    }))
    .exhaustive();

const trackerSeverityVariant = (severity: ProjectAttentionItem["severity"]) =>
  match(severity)
    .with("critical", () => "destructive" as const)
    .with("warning", () => "warning" as const)
    .with("info", () => "slate" as const)
    .exhaustive();

function renderTrackerItem(item: ProjectAttentionItem): RenderedProblemItem {
  return {
    key: item.key,
    title: item.description,
    badges: [
      <Badge key="severity" variant={trackerSeverityVariant(item.severity)}>
        {item.severity}
      </Badge>,
    ],
    details: [
      ...(item.date
        ? [
            <div key="date" className="text-muted-foreground text-sm">
              {formatDate(item.date)}
            </div>,
          ]
        : []),
      ...(item.amount != null
        ? [
            <div key="amount" className="text-muted-foreground text-sm">
              {formatCurrency(item.amount, 0)}
            </div>,
          ]
        : []),
    ],
    route: trackerRoute(item),
    editLabel: `Open ${item.entityType}`,
  };
}

/**
 * "Recount" action for the recount-staleness sections — the only thing that
 * actually restores inventory truth (tenet 1), so link straight into the audit
 * session scoped to the offending location rather than to a form.
 */
function RecountLink({ locationId }: { locationId: string }) {
  return (
    <Button
      size="sm"
      render={
        <Link to="/inventory/session" search={{ parentId: locationId }} />
      }
      nativeButton={false}
    >
      <ScanBarcode className="mr-1 size-3" />
      Recount
    </Button>
  );
}

/**
 * "Show every row spelled this way" — the list page filtered to the variant.
 *
 * The card's own `route` can only be an entity DETAIL route, so it links to one
 * sample record; this is the affordance for seeing the whole set. On purchases
 * the vendor filter is an exact match, so the link isolates the variant
 * precisely; on products `manufacturer` is a substring filter, which lands you
 * on both spellings side by side — arguably the more useful view when you're
 * about to reconcile them.
 */
function VendorVariantLink({ vendor }: { vendor: string }) {
  return (
    <Button
      size="sm"
      variant="outline"
      render={<Link to="/purchases" search={{ vendor }} />}
      nativeButton={false}
    >
      <ListFilter className="mr-1 size-3" />
      Show purchases
    </Button>
  );
}

function ManufacturerVariantLink({ manufacturer }: { manufacturer: string }) {
  return (
    <Button
      size="sm"
      variant="outline"
      render={<Link to="/products" search={{ manufacturer }} />}
      nativeButton={false}
    >
      <ListFilter className="mr-1 size-3" />
      Show products
    </Button>
  );
}

/**
 * `1 product — "Ryobi" has 12`. Shared by both spelling-variant sections, which
 * differ only in the noun and the routes.
 *
 * Phrased around the canonical rather than a verb ("12 use …") so the tie case
 * reads properly: with no majority the counts are 1 and 1, and "1 uses" is
 * correct English that still scans as a typo.
 */
const variantSubtitle = (v: LabelVariant, noun: string) =>
  `${v.count} ${noun}${v.count === 1 ? "" : "s"} — "${v.canonical}" has ${
    v.canonicalCount
  }`;

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
      <Wrench className="mr-1 size-3" />
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

/** `by {mfr} · {n} unit(s) unvalued` — the unpriced-product card subtitle. */
function unpricedSubtitle(product: ProductMissingPrice): string {
  const qty = product.inventoryQuantity;
  return `${byManufacturer(product.manufacturer)} · ${qty} ${qty === 1 ? "unit" : "units"} unvalued`;
}

/** Clickable location chips, matching the duplicate-products card. */
function locationBadges(
  locations: ProductMissingPrice["locations"],
): ReactNode[] {
  return locations.map((location) => (
    <Link key={location.id} to="/locations/$id" params={{ id: location.id }}>
      <Badge
        variant="outline"
        // Free-form location names — opt out of the mono-uppercase stamp.
        className="flex items-center gap-1 font-sans normal-case tracking-normal hover:bg-accent"
      >
        <EntityIcon entity="location" colored className="size-3" />
        {location.name}
      </Badge>
    </Link>
  ));
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
            // Free-form location names — opt out of the mono-uppercase stamp.
            className="flex items-center gap-1 font-sans normal-case tracking-normal hover:bg-accent"
          >
            <EntityIcon entity="location" colored className="size-3" />
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
      "Products with no inventory, no purchase history, and not linked to an ingredient. These may be unused and can potentially be deleted.",
    emptyMessage:
      "No orphaned products found. Every product is stocked, purchased, or linked to an ingredient.",
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
    id: "missing-price",
    label: "Unpriced",
    select: (p) => p.productsMissingPrice,
    entity: "product",
    title: "Stocked Without a Price",
    description:
      "These products are on a shelf but have no price, so their inventory values at nothing and the location totals under-report. Set a price to bring them into the valuation.",
    emptyMessage: "No stocked products are missing a price.",
    renderItem: (product) => ({
      title: product.name,
      subtitle: unpricedSubtitle(product),
      badges: locationBadges(product.locations),
      route: { to: "/products/$id", params: { id: product.id } },
    }),
  }),
  section({
    id: "unvalued-buckets",
    label: "Unvalued buckets",
    select: (p) => p.unvaluedBucketProducts,
    entity: "product",
    title: "Unvalued Bucket Products",
    description:
      "Misc buckets holding inventory with no price. Unlike the section above these are expected to be unpriced — a bucket is a heterogeneous pile, not a unit. Give one a lump-sum price only if you want its contents counted in the valuation.",
    emptyMessage: "Every misc bucket carries a price.",
    renderItem: (product) => ({
      title: getMiscDisplayName(product.name),
      subtitle: unpricedSubtitle(product),
      badges: locationBadges(product.locations),
      route: { to: "/products/$id", params: { id: product.id } },
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
            // Free-form product names — opt out of the mono-uppercase stamp.
            className="flex items-center gap-1 font-sans normal-case tracking-normal hover:bg-accent"
          >
            <EntityIcon entity="product" colored className="size-3" />
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
    id: "stale-recounts",
    label: "Stale recounts",
    select: (p) => p.staleLocations,
    entity: "location",
    title: "Locations overdue for a recount",
    description:
      "Stocked locations that have never been recounted, or not in over 60 days. Inventory never auto-decrements — a deliberate recount is the only thing that makes these numbers true again.",
    emptyMessage: "Every stocked location has been recounted recently.",
    renderItem: (loc) => ({
      title: loc.name,
      badges: [
        <Badge key="type" variant="outline" className="capitalize">
          {loc.type}
        </Badge>,
        <Badge key="items" variant="secondary">
          {loc.itemCount} {loc.itemCount === 1 ? "item" : "items"}
        </Badge>,
      ],
      details: [
        <AuditedHint
          key="recount"
          at={loc.lastBulkInventory}
          label="recounted"
          className="text-sm"
        />,
      ],
      route: { to: "/locations/$id", params: { id: loc.id } },
      editLabel: "Open location",
      customActions: <RecountLink locationId={loc.id} />,
    }),
  }),
  section({
    id: "never-verified",
    label: "Never verified",
    select: (p) => p.neverVerifiedInventory,
    entity: "inventory",
    title: "Inventory never confirmed by a recount",
    description:
      "Entries whose count has never been checked against the shelf (oldest first — a sample, not the full backlog). Recount the location they live in to clear them.",
    emptyMessage: "Every inventory entry has been verified at least once.",
    renderItem: (item) => ({
      title: item.product.name,
      subtitle: `${item.amount.value} ${item.amount.unit}`,
      badges: [
        <Link key="loc" to="/locations/$id" params={{ id: item.location.id }}>
          <Badge
            variant="outline"
            // Free-form location names — opt out of the mono-uppercase stamp.
            className="flex items-center gap-1 font-sans normal-case tracking-normal hover:bg-accent"
          >
            <EntityIcon entity="location" colored className="size-3" />
            {item.location.name}
          </Badge>
        </Link>,
      ],
      details: [createdAgoDetail(item.createdAt)],
      route: { to: "/inventory/$id", params: { id: item.id } },
      editLabel: "Open inventory entry",
      customActions: <RecountLink locationId={item.location.id} />,
    }),
  }),
  section({
    id: "vendor-spellings",
    label: "Vendor spellings",
    select: (p) => p.vendorSpellingVariants,
    entity: "purchase",
    title: "One vendor, two spellings",
    description:
      "Vendor is free text, so the same store can be entered two ways — and the ledger's filter matches exactly, which splits it into two picklist rows and two sets of totals. Rename the odd one out to the spelling already in use.",
    emptyMessage: "Every vendor on the ledger is spelled one way.",
    renderItem: (v) => ({
      // The default title-plus-id key would collide when one canonical name has
      // several variants: they'd share a title only by accident, but the sample
      // id is the discriminator and the spelling is the real identity.
      key: v.value,
      title: v.value,
      subtitle: variantSubtitle(v, "purchase"),
      route: { to: "/purchases/$id", params: { id: v.sampleId } },
      editLabel: "Open purchase",
      customActions: <VendorVariantLink vendor={v.value} />,
    }),
  }),
  section({
    id: "manufacturer-spellings",
    label: "Manufacturer spellings",
    select: (p) => p.manufacturerSpellingVariants,
    entity: "product",
    title: "One manufacturer, two spellings",
    description:
      "The same brand entered two ways splits it across grouping, filters and the manufacturer picklist. Rename the odd one out to the spelling already in use.",
    emptyMessage: "Every manufacturer is spelled one way.",
    renderItem: (v) => ({
      key: v.value,
      title: v.value,
      subtitle: variantSubtitle(v, "product"),
      route: { to: "/products/$id", params: { id: v.sampleId } },
      editLabel: "Open product",
      customActions: <ManufacturerVariantLink manufacturer={v.value} />,
    }),
  }),
  section({
    id: "unknown-parked",
    label: "Parked in Unknown",
    select: (p) => p.unknownParkedItems,
    entity: "inventory",
    title: "Items parked in Unknown",
    description:
      "Stock a capture or import dropped into the global Unknown location because it had no home yet. Move each to a real location.",
    emptyMessage: "Nothing is parked in Unknown.",
    renderItem: (item) => ({
      title: item.product.name,
      subtitle: `${item.amount.value} ${item.amount.unit}`,
      details: [createdAgoDetail(item.createdAt)],
      route: { to: "/inventory/$id", params: { id: item.id } },
      editLabel: "Open inventory entry",
      // Draining Unknown is a recount rooted there — same deep link the other
      // recount detectors offer.
      customActions: <RecountLink locationId={item.location.id} />,
    }),
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
    group: "autoFixable",
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
    id: "orphaned-embeddings",
    label: "Embeddings",
    select: (p) => p.orphanedEntityEmbeddings,
    icon: Wrench,
    title: "Orphaned search embeddings",
    description:
      "Semantic search rows whose entity no longer exists. These are safe to clean up.",
    emptyMessage: "No orphaned search embeddings.",
    group: "autoFixable",
    renderItem: (embedding) => ({
      title: `${embedding.entityType} · ${embedding.entityId.slice(0, 8)}`,
      subtitle: embedding.model,
      details: [createdAgoDetail(embedding.createdAt)],
      route: searchableEntityRoute(embedding),
      inlineFix: {
        label: "Clean up",
        render: (close) => (
          <OrphanedEmbeddingCleanupFix id={embedding.id} close={close} />
        ),
      },
    }),
  }),
  section({
    id: "missing-embeddings",
    label: "Unindexed",
    select: (p) => p.entitiesMissingEmbeddings,
    icon: Wrench,
    title: "Missing search embeddings",
    description:
      "Live records semantic search can't see — no embedding under the current model. The list is a sample; the true figure is on the Fix button and in Maintenance.",
    emptyMessage: "Everything is indexed for semantic search.",
    group: "autoFixable",
    headerAction: <MissingEmbeddingsBackfillAction />,
    renderItem: (entity) => ({
      title: `${entity.entityType} · ${entity.entityId.slice(0, 8)}`,
      route: searchableEntityRoute(entity),
    }),
  }),
  section({
    id: "stale-parent-recipes",
    label: "Deleted sub-recipes",
    select: (p) => p.staleParentRecipes,
    entity: "recipe",
    title: "Recipes referencing a deleted sub-recipe",
    description:
      "Live recipes whose totals still reference a sub-recipe that was deleted (a removal path that skipped staleness propagation). Open each and remove or replace the dangling sub-recipe line so its cost recomputes cleanly — recompute alone can't drop the stale reference.",
    emptyMessage: "No recipes reference a deleted sub-recipe.",
    renderItem: (recipe) => ({
      title: recipe.name,
      route: { to: "/recipes/$id", params: { id: recipe.id } },
      editLabel: "Open recipe",
    }),
  }),
  section({
    id: "tracker",
    label: "Tracker",
    // Merge the seven household-tracker attention rules (the same items
    // /projects?view=overview shows) into one section with a subsection per
    // rule; the per-rule counts stay separate in the schema/badge.
    select: (p) =>
      TRACKER_GROUPS.flatMap((g) => p[TRACKER_PROBLEM_KEY_BY_TYPE[g.type]]),
    icon: AlertTriangle,
    title: "Projects, tasks & purchases needing attention",
    description:
      "Household-tracker items that need a decision: overdue tasks, blocked or stalled projects, planned purchases past their date, spend with no budget or trade recorded, and a manual date override narrower than the work it hides.",
    emptyMessage: "Nothing in the tracker needs attention.",
    groupBy: (items) => groupBy(items, (i) => TRACKER_GROUP_TITLE[i.type]),
    renderItem: renderTrackerItem,
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
  section({
    id: "partial-vendor-orders",
    label: "Split orders",
    select: (p) => p.ordersWithPartialVendor,
    entity: "purchase",
    title: "Orders Split by a Missing Vendor",
    description:
      "An order is grouped by vendor AND order id together, so when only some of its rows record a vendor the order silently splits in two and each half looks complete. Backfilling the vendor rejoins them.",
    emptyMessage:
      "No orders are split by a missing vendor. Every order id agrees with itself on the vendor.",
    renderItem: (order) => {
      // One card per order id, and `route` points at one of its member rows —
      // so the default `title`-`route.params.id` key would collide across two
      // orders that happen to lead with the same purchase. The order id is the
      // card's real identity.
      const soleVendor = order.vendors.length === 1 ? order.vendors[0] : null;
      return {
        key: `partial-vendor:${order.orderId}`,
        title: order.orderId,
        subtitle: soleVendor
          ? `${order.missingCount} of ${order.rowCount} rows missing "${soleVendor}"`
          : `${order.rowCount} rows across conflicting vendors: ${order.vendors.join(", ")}`,
        badges: [
          <Badge key="rows" variant="outline">
            {order.rowCount} rows
          </Badge>,
        ],
        // Lands on one of the vendorless rows, whose "Same Order" section shows
        // exactly the truncated half this card is reporting.
        route: {
          to: "/purchases/$id" as const,
          params: { id: order.purchaseIds[0] ?? "" },
        },
        editLabel: "Open purchase",
        // No fix for the ambiguous case: two real retailers sharing an id
        // format is not something a backfill can adjudicate.
        inlineFix: soleVendor
          ? {
              label: "Backfill vendor",
              render: (close) => (
                <OrderVendorBackfillFix
                  orderId={order.orderId}
                  vendor={soleVendor}
                  missingCount={order.missingCount}
                  close={close}
                />
              ),
            }
          : undefined,
      };
    },
  }),
];
