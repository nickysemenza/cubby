import type { Entity } from "@cubby/schemas/entity";
import type { ReferentialLivenessViolation } from "@cubby/schemas/entity-integrity";
import {
  type AllProblems,
  type CoverageProblemKey,
  type CoverageTotals,
  type LabelVariant,
  type NegativeExpectedQuantity,
  type ProblemKey,
  type ProductMissingPrice,
  type PurchaselessExitExpense,
  type PurchaseNotReconciling,
  type SoldButStillStocked,
  sectionSize,
  type ToolUsedOutsideOwnership,
  TRACKER_PROBLEM_KEY_BY_TYPE,
  type UnlinkedExitExpense,
} from "@cubby/schemas/problems";
import type {
  ProjectAttentionItem,
  ProjectAttentionType,
} from "@cubby/schemas/project";
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
  Store,
  Unlink,
  Wrench,
} from "lucide-react";
import type { ReactNode } from "react";
import { match } from "ts-pattern";
import { useProblemCardMutation } from "~/app/_components/hooks/useProblemCardMutation";
import { OrderIdLink } from "~/app/_components/OrderIdLink";
import { AuditedHint } from "~/app/inventory/session/_components/AuditedHint";
import { mealDateLabel } from "~/app/meals/meal-format";
import { formatDate } from "~/app/projects/project-formatting";
import {
  ReconciliationBadge,
  reconciliationDelta,
} from "~/app/purchases/purchase-reconciliation";
import { Row } from "~/components/layout";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { EntityIcon, entities, entityDetailLink } from "~/entities/entities";
import type { ProblemQuery } from "~/entities/problem-query";
import { problemQuery } from "~/entities/problem-registry";
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
import { ProblemAssembly, problemListLocation } from "./problem-assembly";
import { BackfillButton } from "./problem-backfill-action";
import {
  type IconProp,
  ProblemSection,
  type ProblemSectionCoverage,
  type RenderedProblemItem,
} from "./problem-section";
import { byManufacturer, CodeChip, createdAgoDetail } from "./render-helpers";
import {
  DuplicateProductMergeFix,
  DuplicateVendorMergeFix,
  OrphanedDeleteFix,
} from "./tier2-fixes";
import {
  buildUnitCoverageItems,
  CoverageChips,
  UnitCoverageInlineFix,
  type UnitCoverageItem,
  unitCoverageGroup,
} from "./unit-coverage-fix";
import { VendorLogoFetchAction } from "./vendor-logo-fetch-action";

/**
 * Marks a section as COVERAGE rather than defects (see `PROBLEM_CLASS` in
 * @cubby/schemas/problems). Coverage sections render in their own group with a
 * neutral progress meter and are excluded from `totalProblems` / the navbar
 * badge: they never reach zero — new things arrive faster than they get filed —
 * so counting them as problems is what made the badge permanently red.
 *
 * Presence is the marker, so membership and the meter are one declaration and
 * can't drift. `meter` is optional because `unvalued-buckets` is coverage with
 * no meaningful denominator (a misc bucket isn't a fraction of anything).
 *
 * `keys` welds that marker to the schema's own class declaration: it may only
 * name keys `PROBLEM_CLASS` classes `coverage`, and
 * `SectionsClaimingEveryCoverageKey` (on `PROBLEM_SECTIONS` below) fails to
 * compile if a coverage-classed key has no section claiming it. Without it the
 * two declarations agreed only by hand, and a detector classed coverage but
 * rendered in the defect list would still count toward the badge the class
 * exists to keep actionable.
 *
 * Auto-fixable membership is NOT expressed here — it's derived from
 * `AUTO_FIX_SECTION_IDS` so it can't drift from what the Fix button clears.
 */
type ProblemSectionDeclaredCoverage<
  K extends CoverageProblemKey = CoverageProblemKey,
> = {
  keys: readonly K[];
  meter?: { total: (totals: CoverageTotals) => number; doneLabel: string };
};

/**
 * Bind a declared coverage config to the loaded denominators.
 *
 * `totals` is undefined until its own query resolves, which happens AFTER the
 * four cost-grouped detector queries the page gates on — so coverage sections
 * render with rows but no denominators for a beat. Returning `{}` there (rather
 * than substituting 0) keeps the section styled as coverage while simply
 * omitting the meter; a zero denominator isn't a loading state, it's a wrong
 * number, and it rendered as "-178 / 0".
 */
const resolveCoverage = (
  declared: ProblemSectionDeclaredCoverage | undefined,
  totals: CoverageTotals | undefined,
): ProblemSectionCoverage | undefined => {
  if (!declared) return undefined;
  if (!declared.meter || !totals) return {};
  return {
    meter: {
      total: declared.meter.total(totals),
      doneLabel: declared.meter.doneLabel,
    },
  };
};

/**
 * One row of the Problems page: its scroll anchor, summary-chip label, count,
 * and card. Generic in its coverage declaration so the declared keys survive
 * into `PROBLEM_SECTIONS`, where the exhaustiveness assertion reads them back.
 */
type ProblemSectionEntry<K extends CoverageProblemKey = CoverageProblemKey> = {
  /** Scroll-anchor id; also the summary-chip key. */
  id: string;
  /** Short label shown on the summary chip. */
  label: string;
  /** Issue count, used to show/hide the summary chip. */
  count: (problems: AllProblems) => number;
  /**
   * The section card. `totals` carries the coverage denominators (loaded by a
   * separate cheap query); defect sections ignore it.
   */
  node: (
    problems: AllProblems,
    totals: CoverageTotals | undefined,
  ) => ReactNode;
  /** Present ⇒ coverage, not a defect; absent ⇒ the main defect list. */
  coverage?: ProblemSectionDeclaredCoverage<K>;
  /** Canonical query branches shown in this section's assembly. */
  problemKeys?: readonly ProblemKey[];
};

/**
 * Declare a section from data: static `ProblemSection` props plus a `select`
 * (the single source for both the count and the rendered items) and a
 * `renderItem`. The element type flows from `select` into `renderItem` with no
 * annotations. `headerAction` is a `<BackfillButton>` for the "fix all" sections.
 */
function section<T, K extends CoverageProblemKey = never>(config: {
  id: string;
  label: string;
  select: (problems: AllProblems) => readonly T[];
  /**
   * Set when `select` returns a PAGE rather than the whole set — i.e. for a
   * view-backed section, whose rows come from page one of an entity list.
   * Names the `sectionTotals` entry carrying the real population, so the chip
   * count and the card's meter describe the backlog instead of the page.
   */
  totalKey?: ProblemKey;
  /** Override only for a section that combines several Problem definitions. */
  title?: string;
  description?: string;
  emptyMessage?: string;
  icon?: LucideIcon;
  entity?: Entity;
  renderItem: (item: T) => RenderedProblemItem;
  groupBy?: (items: T[]) => Record<string, T[]>;
  /** Registry keys represented by this section; multiple keys are OR branches. */
  problemKeys?: readonly ProblemKey[];
  /**
   * A static "fix all" node, or one built from the section's contents.
   *
   * The builder gets the true `count` alongside the rendered `items`, because a
   * view-backed section renders only a page — a bulk action wired to `items`
   * would act on twelve and label itself "all".
   */
  headerAction?: ReactNode | ((items: T[], count: number) => ReactNode);
  coverage?: ProblemSectionDeclaredCoverage<K>;
}): ProblemSectionEntry<K> {
  const iconProp: IconProp = config.entity
    ? { entity: config.entity }
    : { icon: config.icon as LucideIcon };
  const canonicalPresentation =
    config.problemKeys?.length === 1
      ? problemQuery(config.problemKeys[0] as ProblemKey)
      : undefined;
  const title = config.title ?? canonicalPresentation?.title;
  const description = config.description ?? canonicalPresentation?.description;
  const emptyMessage =
    config.emptyMessage ?? canonicalPresentation?.emptyMessage;
  if (!title || !description || !emptyMessage) {
    throw new Error(
      `Problem section "${config.id}" needs one canonical Problem key or explicit presentation copy`,
    );
  }
  return {
    id: config.id,
    label: config.label,
    // Must be forwarded, not just closed over by `node` below: the page groups
    // sections by reading THIS field. Omitting it still rendered a correct
    // meter (node reads `config` directly) while the section itself sat in the
    // defect list — a mismatch the meter hides rather than reveals.
    coverage: config.coverage,
    problemKeys: config.problemKeys,
    count: (problems) =>
      sectionSize(
        config.totalKey,
        config.select(problems),
        problems.sectionTotals,
      ),
    node: (problems, totals) => {
      const items = [...config.select(problems)];
      const count = sectionSize(config.totalKey, items, problems.sectionTotals);
      return (
        <ProblemSection
          {...iconProp}
          title={title}
          description={description}
          emptyMessage={emptyMessage}
          items={items}
          count={count}
          renderItem={config.renderItem}
          groupBy={config.groupBy}
          assembly={problemAssembly(
            config.problemKeys,
            problems,
            problems.conversionCoverageFreshness,
          )}
          coverage={resolveCoverage(config.coverage, totals)}
          headerAction={
            typeof config.headerAction === "function"
              ? config.headerAction(items, count)
              : config.headerAction
          }
        />
      );
    },
  };
}

/** Escape hatch for a section that needs its own component (e.g. section-level state). */
function customSection<T, K extends CoverageProblemKey = never>(def: {
  id: string;
  label: string;
  select: (problems: AllProblems) => readonly T[];
  /** See `section`'s `totalKey` — set when `select` returns a page. */
  totalKey?: ProblemKey;
  render: (
    items: T[],
    coverage: ProblemSectionCoverage | undefined,
    count: number,
    assembly: ReactNode | undefined,
  ) => ReactNode;
  problemKeys?: readonly ProblemKey[];
  coverage?: ProblemSectionDeclaredCoverage<K>;
}): ProblemSectionEntry<K> {
  const sizeOf = (problems: AllProblems, items: readonly unknown[]) =>
    sectionSize(def.totalKey, items, problems.sectionTotals);
  return {
    id: def.id,
    label: def.label,
    coverage: def.coverage,
    problemKeys: def.problemKeys,
    count: (problems) => sizeOf(problems, def.select(problems)),
    node: (problems, totals) => {
      const items = [...def.select(problems)];
      return def.render(
        items,
        resolveCoverage(def.coverage, totals),
        sizeOf(problems, items),
        problemAssembly(
          def.problemKeys,
          problems,
          problems.conversionCoverageFreshness,
        ),
      );
    },
  };
}

/** Resolve the currently migrated registry entries without making UI own SQL. */
function problemAssembly(
  keys: readonly ProblemKey[] | undefined,
  problems: AllProblems,
  projectionFreshness?: AllProblems["conversionCoverageFreshness"],
): ReactNode | undefined {
  const queries = (keys ?? [])
    .map(problemQuery)
    .filter((query): query is ProblemQuery => query != null);
  if (!queries.length) return undefined;
  const listLocations = queries.flatMap((query) => {
    const location = problemListLocation(query);
    return location
      ? [
          {
            query,
            location,
            count: problems.sectionTotals[query.key] ?? 0,
          },
        ]
      : [];
  });
  return (
    <ProblemAssembly
      queries={queries}
      listLocations={listLocations}
      projectionFreshness={projectionFreshness}
    />
  );
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

/**
 * `{pluralLabel} · {edgeKey}` — clusters violations first by the entity left
 * dangling, then by the specific FK column, so 34 possible edges don't render
 * as one flat wall of identical-looking rows.
 */
function referentialLivenessGroup(v: ReferentialLivenessViolation): string {
  return `${entities[v.targetEntity].pluralLabel} · ${v.edgeKey}`;
}

/** `Table.column` — mono, the exact FK the audit failed on. */
function edgeKeyDetail(edgeKey: string): ReactNode {
  return (
    <div key="edge" className="font-mono text-muted-foreground text-xs">
      {edgeKey}
    </div>
  );
}

/** `Source SourceTable #id` — the live row carrying the dangling pointer. */
function sourceDetail(sourceTable: string, sourceId: string): ReactNode {
  return (
    <Row
      key="source"
      align="center"
      gap="xs"
      className="text-muted-foreground text-sm"
    >
      Source{" "}
      <CodeChip>
        {sourceTable} #{sourceId.slice(0, 8)}
      </CodeChip>
    </Row>
  );
}

/**
 * The soft-deleted target the dangling edge still points at. No name to show
 * (the row is gone from every normal query), so this shows the entity +
 * truncated id rather than a name. Deliberately NOT a link: the target is
 * soft-deleted, so every detail route 404s on it — this is one of the two
 * documented exceptions to the entities.tsx "a rendered entity is always
 * clickable" rule, alongside orphaned embeddings.
 */
function referentialTargetBadge(v: ReferentialLivenessViolation): ReactNode {
  return (
    <Badge
      key="target"
      variant="outline"
      title={v.targetId}
      // Free-form identifier, not a categorical tag — opt out of the
      // mono-uppercase stamp (matches the location/vendor badge idiom).
      className="flex items-center gap-1 font-sans normal-case tracking-normal"
    >
      <EntityIcon entity={v.targetEntity} colored className="size-3" />
      {entities[v.targetEntity].label} {v.targetId.slice(0, 8)}
    </Badge>
  );
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
  { type: "past_due_planned_expense", title: "Planned expenses past due" },
  { type: "missing_budget", title: "Missing a cost estimate" },
  { type: "unclassified_expense", title: "Unclassified expenses" },
  { type: "date_window_drift", title: "Date window drift" },
];

const TRACKER_GROUP_TITLE = Object.fromEntries(
  TRACKER_GROUPS.map((g) => [g.type, g.title]),
) as Record<ProjectAttentionType, string>;

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
    // `href` is already a shortcode-bearing path built server-side
    // (`/tasks/${row.id}` etc. in server/repo/project/attention.ts) —
    // no uuid-to-shortcode resolution is needed here.
    route: { href: item.href },
    editLabel: `Open ${item.entityType}`,
  };
}

/**
 * "Recount" action for the recount-staleness sections — the only thing that
 * actually restores inventory truth (tenet 1), so link straight into the audit
 * session scoped to the offending location rather than to a form.
 */
function RecountLink({ shortcode }: { shortcode: string }) {
  return (
    <Button
      size="sm"
      render={<Link to="/inventory/session" search={{ parent: shortcode }} />}
      nativeButton={false}
    >
      <ScanBarcode className="mr-1 size-3" />
      Recount
    </Button>
  );
}

/**
 * "Show every row spelled this way" — the products list filtered to the
 * variant.
 *
 * The card's own `route` can only be an entity DETAIL route, so it links to one
 * sample record; this is the affordance for seeing the whole set. `manufacturer`
 * is a substring filter, which lands you on both spellings side by side —
 * arguably the more useful view when you're about to reconcile them.
 */
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
 * `1 product — "Ryobi" has 12`. Takes the noun as a parameter rather than
 * hardcoding "product" so a second free-text brand column's spelling-variant
 * section could reuse it.
 *
 * Phrased around the canonical rather than a verb ("12 use …") so the tie case
 * reads properly: with no majority the counts are 1 and 1, and "1 uses" is
 * correct English that still scans as a typo.
 */
const variantSubtitle = (
  v: Pick<LabelVariant, "count" | "canonical" | "canonicalCount">,
  noun: string,
) =>
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
    route: entityDetailLink("product", item.id),
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

/**
 * `by {mfr} · sold 1, 1 still on a shelf · $700.00 recovered`. Both quantities
 * remain useful context for the human review, while membership is decided by
 * the canonical quantity ledger. `proceeds` is stored negative because it is a
 * disposal.
 */
function soldButStockedSubtitle(product: SoldButStillStocked): string {
  const live = product.liveQuantity;
  const stocked = `${live} still on a shelf`;
  return `${byManufacturer(product.manufacturer)} · sold ${product.soldQuantity}, ${stocked} · ${formatCurrency(Math.abs(product.proceeds))} recovered`;
}

/**
 * Leads with the arithmetic, because the arithmetic IS the finding — and names
 * the unquantified lines when there are any, since those change which fix
 * applies. Unknown acquisitions usually mean a receipt whose count was never
 * recorded; a fully quantified ledger that still goes negative means a real
 * acquisition row is missing or an exit is on the wrong product.
 */
function negativeExpectedSubtitle(row: NegativeExpectedQuantity): string {
  const unknown = row.unknownAcquisitionLines + row.unknownExitLines;
  return [
    byManufacturer(row.manufacturer),
    `${row.acquiredUnits} acquired, ${row.exitedUnits} gone → ${row.expectedQuantity}`,
    unknown > 0 ? `${unknown} line(s) carry no quantity` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/**
 * The vendor and the money, because between them they are what identifies which
 * product a payout describes — which is the whole of the work on these rows.
 */
function unlinkedExitSubtitle(row: UnlinkedExitExpense): string {
  return [row.vendorName, formatCurrency(Math.abs(row.cost)), row.date]
    .filter(Boolean)
    .join(" · ");
}

/** No vendor to show — these rows have no Purchase — so the project stands in. */
function purchaselessExitSubtitle(row: PurchaselessExitExpense): string {
  return [row.projectName, formatCurrency(Math.abs(row.cost)), row.date]
    .filter(Boolean)
    .join(" · ");
}

/**
 * Both dates, because they are what tells you which of the two fixes applies:
 * an acquisition a few weeks late usually means a missing purchase Expense,
 * one a year late means the edge itself is wrong.
 */
function outsideOwnershipSubtitle(row: ToolUsedOutsideOwnership): string {
  return row.conflict === "acquired_after_end"
    ? `${byManufacturer(row.manufacturer)} · acquired ${row.toolDate}, after ${row.projectName} ended ${row.projectBoundary}`
    : `${byManufacturer(row.manufacturer)} · disposed of ${row.toolDate}, before ${row.projectName} started ${row.projectBoundary}`;
}

/** Clickable location chips, matching the duplicate-products card. */
function locationBadges(
  locations: ProductMissingPrice["locations"],
): ReactNode[] {
  return locations.map((location) => (
    <Link
      key={location.id}
      to="/locations/$shortcode"
      params={{ shortcode: location.id }}
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
  ));
}

/** `Stated $431.24 · expenses $416.24 across 3 expenses`. */
function purchaseSubtitle(purchase: PurchaseNotReconciling): string {
  const expenses = `${purchase.expenseCount} ${purchase.expenseCount === 1 ? "expense" : "expenses"}`;
  return `Stated ${formatCurrency(purchase.statedTotal)} · expenses ${formatCurrency(purchase.expenseTotal)} across ${expenses}`;
}

/**
 * Names the unexplained discrepancy by direction. Refund-adjusted purchases are
 * excluded by the detector before reaching this worklist.
 */
function purchaseDeltaHint(purchase: PurchaseNotReconciling): string | null {
  const delta = reconciliationDelta(purchase);
  if (delta === null) return null;
  const gap = formatCurrency(Math.abs(delta));
  return delta < 0
    ? `Expenses come in ${gap} under the stated total, and posted refund evidence does not fully explain the difference.`
    : `Expenses come in ${gap} over the stated total — an extra expense, or a stated total captured before one was added.`;
}

/** The coverage keys a list of sections claims through their `coverage.keys`. */
type ClaimedCoverageKey<S extends readonly ProblemSectionEntry[]> = NonNullable<
  S[number]["coverage"]
>["keys"][number];

/**
 * The section list, but only if its coverage sections claim every key
 * `PROBLEM_CLASS` classes `coverage` — otherwise a shape nothing can satisfy,
 * whose one property names the unclaimed keys.
 *
 * This is the other half of the weld (see `ProblemSectionDeclaredCoverage`).
 * The schema's `coverage` class and this file's coverage sections are two
 * independent declarations of one membership and agreed only by hand: a key
 * classed `coverage` with no section claiming it would render in the defect
 * list and go on counting toward the badge the class exists to keep actionable.
 * The other direction — a section claiming a key that isn't classed `coverage`
 * — is the `CoverageProblemKey` type on `keys` itself, and a `keys` list that
 * disagrees with the section's own `select` is caught in
 * problem-sections.unit.test.tsx.
 */
type SectionsClaimingEveryCoverageKey<
  S extends readonly ProblemSectionEntry[],
> = [Exclude<CoverageProblemKey, ClaimedCoverageKey<S>>] extends [never]
  ? readonly ProblemSectionEntry[]
  : {
      coverageKeysWithNoSection: Exclude<
        CoverageProblemKey,
        ClaimedCoverageKey<S>
      >;
    };

/**
 * The Problems page in declaration order — the summary chips and the section
 * list both derive from this, so adding a check is a single entry here.
 *
 * Declared without a type annotation on purpose: annotating the literal
 * contextually types each `section(...)` call, which erases the coverage keys
 * the weld below reads back out of it.
 */
const DECLARED_SECTIONS = [
  section({
    id: "duplicates",
    label: "Duplicates",
    select: (p) => p.duplicateInventory,
    problemKeys: ["duplicateInventory"],
    entity: "product",
    renderItem: (product) => ({
      title: product.name,
      subtitle: byManufacturer(product.manufacturer),
      badges: product.locations.map((location) => (
        <Link
          key={location.id}
          to="/locations/$shortcode"
          params={{ shortcode: location.id }}
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
      route: entityDetailLink("product", product.id),
    }),
  }),
  section({
    id: "duplicate-products",
    label: "Duplicate products",
    select: (p) => p.duplicateProductIdentities,
    problemKeys: ["duplicateProductIdentities"],
    entity: "product",
    renderItem: (dupe) => ({
      key: `${dupe.manufacturer}/${dupe.model}`,
      title: `${dupe.manufacturer} ${dupe.model}`,
      subtitle: dupe.products.map((p) => p.name).join(" · "),
      badges: dupe.products.map((p) => (
        <Link key={p.id} to="/products/$shortcode" params={{ shortcode: p.id }}>
          <Badge variant="outline" className="hover:bg-accent">
            {p.id}
          </Badge>
        </Link>
      )),
      route: entityDetailLink("product", dupe.products[0]?.id ?? ""),
      inlineFix: {
        label: "Merge",
        render: (close) => (
          <DuplicateProductMergeFix variant={dupe} close={close} />
        ),
      },
    }),
  }),
  section({
    id: "orphaned",
    label: "Orphaned",
    select: (p) => p.orphanedProducts,
    problemKeys: ["orphanedProducts"],
    entity: "product",
    renderItem: (product) => ({
      title: product.name,
      subtitle: byManufacturer(product.manufacturer),
      details: [createdAgoDetail(product.createdAt)],
      route: entityDetailLink("product", product.id),
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
    problemKeys: ["productsMissingPrice"],
    totalKey: "productsMissingPrice",
    entity: "product",
    renderItem: (product) => ({
      title: product.name,
      subtitle: unpricedSubtitle(product),
      badges: locationBadges(product.locations),
      route: entityDetailLink("product", product.id),
    }),
  }),
  section({
    id: "sold-but-still-stocked",
    label: "Sold but stocked",
    select: (p) => p.soldButStillStocked,
    problemKeys: ["soldButStillStocked"],
    entity: "product",
    renderItem: (product) => ({
      title: product.name,
      subtitle: soldButStockedSubtitle(product),
      badges: locationBadges(product.locations),
      route: entityDetailLink("product", product.id),
    }),
  }),
  section({
    id: "unlinked-exit-expenses",
    label: "Sold without a product",
    select: (p) => p.unlinkedExitExpenses,
    problemKeys: ["unlinkedExitExpenses"],
    entity: "expense",
    renderItem: (row) => ({
      title: row.name,
      subtitle: unlinkedExitSubtitle(row),
      route: entityDetailLink("expense", row.id),
    }),
  }),
  section({
    id: "purchaseless-exit-expenses",
    label: "Credit with no order",
    select: (p) => p.purchaselessExitExpenses,
    problemKeys: ["purchaselessExitExpenses"],
    entity: "expense",
    // No meter: half these rows are correct as they stand, so there is no
    // denominator this is a fraction of — the same reason `unvalued-buckets`
    // declares coverage without one.
    coverage: { keys: ["purchaselessExitExpenses"] },
    renderItem: (row) => ({
      title: row.name,
      subtitle: purchaselessExitSubtitle(row),
      route: entityDetailLink("expense", row.id),
    }),
  }),
  section({
    id: "negative-expected-quantity",
    label: "Negative expected",
    select: (p) => p.negativeExpectedQuantity,
    problemKeys: ["negativeExpectedQuantity"],
    totalKey: "negativeExpectedQuantity",
    entity: "product",
    renderItem: (row) => ({
      title: row.name,
      subtitle: negativeExpectedSubtitle(row),
      route: entityDetailLink("product", row.id),
    }),
  }),
  section({
    id: "tools-used-outside-ownership",
    label: "Used before owned",
    select: (p) => p.toolsUsedOutsideOwnership,
    problemKeys: ["toolsUsedOutsideOwnership"],
    entity: "product",
    renderItem: (row) => ({
      title: row.name,
      subtitle: outsideOwnershipSubtitle(row),
      badges: [
        <Link
          key={row.projectId}
          {...entityDetailLink("project", row.projectId)}
          className="hover:underline"
        >
          <Badge variant="outline">{row.projectName}</Badge>
        </Link>,
      ],
      route: entityDetailLink("product", row.id),
    }),
  }),
  section({
    id: "unvalued-buckets",
    label: "Unvalued buckets",
    select: (p) => p.unvaluedBucketProducts,
    problemKeys: ["unvaluedBucketProducts"],
    totalKey: "unvaluedBucketProducts",
    // Coverage, but with no meter: a misc bucket isn't a fraction of any
    // population, so there's nothing honest to put in a denominator.
    coverage: { keys: ["unvaluedBucketProducts"] },
    entity: "product",
    renderItem: (product) => ({
      title: getMiscDisplayName(product.name),
      subtitle: unpricedSubtitle(product),
      badges: locationBadges(product.locations),
      route: entityDetailLink("product", product.id),
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
    problemKeys: [
      "productsWithoutMappings",
      "ingredientsWithPartialCoverage",
      "productsWithIslandedMappings",
    ],
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
    problemKeys: ["ingredientsWithoutProduct"],
    totalKey: "ingredientsWithoutProduct",
    coverage: {
      keys: ["ingredientsWithoutProduct"],
      meter: {
        total: (t) => t.ingredientsWithoutProduct,
        doneLabel: "linked to a product",
      },
    },
    entity: "ingredient",
    renderItem: (ing) => ({
      title: ing.name,
      details: [
        `Used in ${ing.recipeCount} recipe${ing.recipeCount === 1 ? "" : "s"}`,
      ],
      route: entityDetailLink("ingredient", ing.id),
      // The workbench can actually create the product; the detail page can't.
      customActions: <WorkbenchFixLink ingredientId={ing.id} />,
    }),
  }),
  section({
    id: "unused-with-product",
    label: "Unused (has product)",
    select: (p) => p.unusedIngredientsWithProduct,
    problemKeys: ["unusedIngredientsWithProduct"],
    totalKey: "unusedIngredientsWithProduct",
    entity: "ingredient",
    headerAction: (_items, count) => (
      <DeleteAllUnusedButton
        count={count}
        problemKey="unusedIngredientsWithProduct"
        alsoDeleteProducts
      />
    ),
    renderItem: (ing) => ({
      title: ing.name,
      details: [createdAgoDetail(ing.createdAt)],
      badges: ing.products.map((prod) => (
        <Link
          key={prod.id}
          to="/products/$shortcode"
          params={{ shortcode: prod.id }}
        >
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
      route: entityDetailLink("ingredient", ing.id),
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
    problemKeys: ["unusedIngredientsWithoutProduct"],
    totalKey: "unusedIngredientsWithoutProduct",
    entity: "ingredient",
    headerAction: (_items, count) => (
      <DeleteAllUnusedButton
        count={count}
        problemKey="unusedIngredientsWithoutProduct"
        alsoDeleteProducts={false}
      />
    ),
    renderItem: (ing) => ({
      title: ing.name,
      details: [createdAgoDetail(ing.createdAt)],
      route: entityDetailLink("ingredient", ing.id),
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
    problemKeys: ["emptyLocations"],
    totalKey: "emptyLocations",
    coverage: {
      keys: ["emptyLocations"],
      meter: { total: (t) => t.emptyLocations, doneLabel: "itemized" },
    },
    render: (items, coverage, count, assembly) => (
      <EmptyLocationsList
        locations={items}
        coverage={coverage}
        count={count}
        assembly={assembly}
      />
    ),
  }),
  section({
    id: "stale-recounts",
    label: "Stale recounts",
    select: (p) => p.staleLocations,
    problemKeys: ["staleLocations"],
    totalKey: "staleLocations",
    coverage: {
      keys: ["staleLocations"],
      meter: { total: (t) => t.staleLocations, doneLabel: "recounted" },
    },
    entity: "location",
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
      route: entityDetailLink("location", loc.id),
      editLabel: "Open location",
      customActions: <RecountLink shortcode={loc.id} />,
    }),
  }),
  section({
    id: "never-verified",
    label: "Never verified",
    select: (p) => p.neverVerifiedInventory,
    problemKeys: ["neverVerifiedInventory"],
    // Rows are page one of the inventory list; the meter must not read them.
    totalKey: "neverVerifiedInventory",
    coverage: {
      keys: ["neverVerifiedInventory"],
      meter: { total: (t) => t.neverVerifiedInventory, doneLabel: "verified" },
    },
    entity: "inventory",
    renderItem: (item) => ({
      title: item.product.name,
      subtitle: `${item.amount.value} ${item.amount.unit}`,
      badges: [
        <Link
          key="loc"
          to="/locations/$shortcode"
          params={{ shortcode: item.location.id }}
        >
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
      route: entityDetailLink("inventory", item.id),
      editLabel: "Open inventory entry",
      customActions: <RecountLink shortcode={item.location.id} />,
    }),
  }),
  section({
    id: "manufacturer-spellings",
    label: "Manufacturer spellings",
    select: (p) => p.manufacturerSpellingVariants,
    problemKeys: ["manufacturerSpellingVariants"],
    entity: "product",
    renderItem: (v) => ({
      key: v.value,
      title: v.value,
      subtitle: variantSubtitle(v, "product"),
      route: entityDetailLink("product", v.sampleId),
      editLabel: "Open product",
      customActions: <ManufacturerVariantLink manufacturer={v.value} />,
    }),
  }),
  section({
    id: "duplicate-vendors",
    label: "Duplicate vendors",
    select: (p) => p.duplicateVendors,
    problemKeys: ["duplicateVendors"],
    entity: "vendor",
    renderItem: (v) => ({
      // Names are unique among live vendors, so the variant spelling is a stable
      // per-card key.
      key: v.value,
      title: v.value,
      // Weighed by purchases, not by roster rows — a duplicate is 1 row either way,
      // so the purchase count is what says which spelling is the real one.
      subtitle: variantSubtitle(v, "purchase"),
      route: entityDetailLink("vendor", v.sampleId),
      editLabel: "Open vendor",
      inlineFix: {
        label: "Merge",
        render: (close) => (
          <DuplicateVendorMergeFix variant={v} close={close} />
        ),
      },
    }),
  }),
  section({
    id: "vendor-mini-logos",
    label: "Vendor logos",
    select: (p) => p.vendorsWithoutLogos,
    problemKeys: ["vendorsWithoutLogos"],
    coverage: {
      keys: ["vendorsWithoutLogos"],
      meter: {
        total: (t) => t.vendorsWithPurchases,
        doneLabel: "with a mini logo",
      },
    },
    icon: Store,
    renderItem: (vendor) => ({
      title: vendor.name,
      subtitle: vendor.website ?? "No website recorded",
      badges: [
        <Badge key="purchases" variant="secondary">
          {vendor.purchaseCount}{" "}
          {vendor.purchaseCount === 1 ? "purchase" : "purchases"}
        </Badge>,
        <Badge key="expenses" variant="outline">
          {vendor.expenseRowCount}{" "}
          {vendor.expenseRowCount === 1 ? "expense line" : "expense lines"}
        </Badge>,
      ],
      route: entityDetailLink("vendor", vendor.id),
      editLabel: "Open vendor",
      customActions: <VendorLogoFetchAction vendor={vendor} />,
    }),
  }),
  section({
    id: "unknown-parked",
    label: "Parked in Unknown",
    select: (p) => p.unknownParkedItems,
    problemKeys: ["unknownParkedItems"],
    entity: "inventory",
    renderItem: (item) => ({
      title: item.product.name,
      subtitle: `${item.amount.value} ${item.amount.unit}`,
      details: [createdAgoDetail(item.createdAt)],
      route: entityDetailLink("inventory", item.id),
      editLabel: "Open inventory entry",
      // Draining Unknown is a recount rooted there — same deep link the other
      // recount detectors offer.
      customActions: <RecountLink shortcode={item.location.id} />,
    }),
  }),
  section({
    id: "inventory-no-price-path",
    label: "Unvaluable units",
    select: (p) => p.inventoryWithoutPricePath,
    problemKeys: ["inventoryWithoutPricePath"],
    entity: "inventory",
    renderItem: (item) => ({
      title: item.product.name,
      subtitle: `${item.amount.value} ${item.amount.unit} in ${item.location.name}`,
      badges: [
        <Badge key="price" variant="outline">
          {formatCurrency(item.effectivePrice)} each
        </Badge>,
      ],
      route: entityDetailLink("product", item.product.id),
      editLabel: "Open product",
    }),
  }),
  section({
    id: "images",
    label: "Images",
    select: (p) => p.productsWithNoImages,
    problemKeys: ["productsWithNoImages"],
    coverage: {
      keys: ["productsWithNoImages"],
      meter: {
        total: (t) => t.productsWithNoImages,
        doneLabel: "photographed",
      },
    },
    icon: ImageOff,
    headerAction: <BackfillButton {...BACKFILL.fetchUpcImages} />,
    renderItem: (product) => ({
      title: product.name,
      subtitle: byManufacturer(product.manufacturer),
      badges: product.upc ? [<CodeChip key="upc">{product.upc}</CodeChip>] : [],
      route: entityDetailLink("product", product.id),
    }),
  }),
  section({
    id: "ai-descriptions",
    label: "AI Descriptions",
    select: (p) => p.locationsWithoutAiDescription ?? [],
    problemKeys: ["locationsWithoutAiDescription"],
    totalKey: "locationsWithoutAiDescription",
    icon: Sparkles,
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
      route: entityDetailLink("location", location.id),
    }),
  }),
  section({
    id: "orphaned-embeddings",
    label: "Embeddings",
    select: (p) => p.orphanedEntityEmbeddings,
    problemKeys: ["orphanedEntityEmbeddings"],
    icon: Wrench,
    renderItem: (embedding) => ({
      // The embedding row's own id is stable and unique on its own — no route
      // to derive a fallback key from (see the comment on `route` below).
      key: embedding.id,
      title: `${embedding.entityType} · ${embedding.entityId.slice(0, 8)}`,
      subtitle: embedding.model,
      details: [createdAgoDetail(embedding.createdAt)],
      // No `route`: this row exists precisely BECAUSE its entity was deleted
      // (an orphaned embedding), so there is no live page to link to — the
      // pre-cutover code linked to a uuid URL that already 404'd. Leave it
      // unlinked rather than "restoring" a link to nothing.
      inlineFix: {
        label: "Clean up",
        render: (close) => (
          <OrphanedEmbeddingCleanupFix id={embedding.id} close={close} />
        ),
      },
    }),
  }),
  section({
    id: "unreferenced-images",
    label: "Files",
    select: (p) => p.unreferencedImages,
    problemKeys: ["unreferencedImages"],
    icon: Wrench,
    renderItem: (file) => ({
      key: file.id,
      title: file.filename,
      // Provenance, not a link: `targetType`/`targetId` are stamped at attach
      // time and the entity they name may itself be gone, which is often the
      // very reason the file ended up here. Same call as the orphaned-embedding
      // section below — no `route`.
      subtitle: file.targetType
        ? `${file.targetType} · ${file.targetId?.slice(0, 8) ?? "unknown"}`
        : file.contentType,
      details: [
        `${Math.round(file.size / 1024)} KB`,
        createdAgoDetail(file.createdAt),
      ],
    }),
  }),
  section({
    id: "missing-embeddings",
    label: "Unindexed",
    select: (p) => p.entitiesMissingEmbeddings,
    problemKeys: ["entitiesMissingEmbeddings"],
    icon: Wrench,
    headerAction: <MissingEmbeddingsBackfillAction />,
    renderItem: (entity) => ({
      title: `${entity.entityType} · ${entity.entityId.slice(0, 8)}`,
      // Live entity ⇒ always resolvable to a real page, unlike the orphaned
      // side of this pair — see the note on `entityMissingEmbeddingSchema`.
      route: entityDetailLink(entity.entityType, entity.entityId),
    }),
  }),
  section({
    id: "stale-parent-recipes",
    label: "Deleted sub-recipes",
    select: (p) => p.staleParentRecipes,
    problemKeys: ["staleParentRecipes"],
    entity: "recipe",
    renderItem: (recipe) => ({
      title: recipe.name,
      route: entityDetailLink("recipe", recipe.id),
      editLabel: "Open recipe",
    }),
  }),
  section({
    id: "empty-cooked-meals",
    label: "Empty meals",
    select: (p) => p.emptyCookedMeals,
    problemKeys: ["emptyCookedMeals"],
    totalKey: "emptyCookedMeals",
    entity: "meal",
    renderItem: (meal) => ({
      title: meal.name ?? mealDateLabel(meal),
      subtitle: meal.name ? mealDateLabel(meal) : undefined,
      route: entityDetailLink("meal", meal.id),
      editLabel: "Open meal",
    }),
  }),
  section({
    id: "understated-cost-meals",
    label: "Understated cost",
    select: (p) => p.understatedCostMeals,
    problemKeys: ["understatedCostMeals"],
    entity: "meal",
    renderItem: (meal) => ({
      title: meal.name ?? mealDateLabel(meal),
      subtitle: `${mealDateLabel(meal)} · ${meal.recipeCount} recipe${
        meal.recipeCount === 1 ? "" : "s"
      } with unpriced ingredients`,
      route: entityDetailLink("meal", meal.id),
      editLabel: "Open meal",
    }),
  }),
  section({
    id: "recipes-without-instructions",
    label: "No instructions",
    select: (p) => p.recipesWithoutInstructions,
    problemKeys: ["recipesWithoutInstructions"],
    totalKey: "recipesWithoutInstructions",
    entity: "recipe",
    renderItem: (recipe) => ({
      title: recipe.name,
      subtitle:
        recipe.sectionCount === 0
          ? "No sections"
          : `${recipe.sectionCount} section${
              recipe.sectionCount === 1 ? "" : "s"
            }, none with instructions`,
      route: entityDetailLink("recipe", recipe.id),
      editLabel: "Open recipe",
    }),
  }),
  section({
    id: "referential-liveness",
    label: "Dangling refs",
    select: (p) => p.referentialLivenessViolations,
    problemKeys: ["referentialLivenessViolations"],
    icon: Unlink,
    groupBy: (items) =>
      groupBy(
        [...items].sort((a, b) =>
          referentialLivenessGroup(a).localeCompare(
            referentialLivenessGroup(b),
          ),
        ),
        referentialLivenessGroup,
      ),
    renderItem: (v) => ({
      // (edgeKey, sourceId) is the natural key — one FK column can only point
      // at one target per source row.
      key: `${v.edgeKey}-${v.sourceId}`,
      title: v.description,
      details: [
        edgeKeyDetail(v.edgeKey),
        sourceDetail(v.sourceTable, v.sourceId),
      ],
      badges: [referentialTargetBadge(v)],
      // No route: the target is the SOFT-DELETED row the edge shouldn't still
      // point at, so every detail route 404s on it by design. The pre-cutover
      // code linked it anyway — to a uuid URL that already dead-ended.
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
    problemKeys: TRACKER_GROUPS.map(
      (group) => TRACKER_PROBLEM_KEY_BY_TYPE[group.type],
    ),
    icon: AlertTriangle,
    title: "Projects, tasks & expenses needing attention",
    description:
      "Household-tracker items that need a decision: overdue tasks, blocked or stalled projects, planned expenses past their date, spend with no budget or trade recorded, and a manual date override narrower than the work it hides.",
    emptyMessage: "Nothing in the tracker needs attention.",
    groupBy: (items) => groupBy(items, (i) => TRACKER_GROUP_TITLE[i.type]),
    renderItem: renderTrackerItem,
  }),
  section({
    id: "upc-updates",
    label: "UPC Updates",
    select: (p) => p.productsWithBetterUpcData ?? [],
    problemKeys: ["productsWithBetterUpcData"],
    icon: Download,
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
        route: entityDetailLink("product", product.id),
        editLabel: "Open product",
        customActions: <UpcApplyAction product={product} />,
      };
    },
  }),
  section({
    id: "purchases-not-reconciling",
    label: "Stated totals",
    select: (p) => p.purchasesNotReconciling,
    problemKeys: ["purchasesNotReconciling"],
    // Advisory, so it declares `coverage` — that marker is what keeps it out of
    // the defect list, out of the red, and out of `totalProblems`. No meter: a
    // discrepancy isn't a fraction of a population, and "N of M purchases
    // reconcile" would read as a score to drive to 100%, which this isn't.
    coverage: { keys: ["purchasesNotReconciling"] },
    entity: "purchase",
    renderItem: (purchase) => {
      const hint = purchaseDeltaHint(purchase);
      return {
        // A purchase has no name, and two purchases from one vendor would otherwise
        // share a card key by way of the title.
        key: purchase.id,
        title: purchase.vendorName ?? "Vendor deleted",
        subtitle: purchaseSubtitle(purchase),
        details: hint
          ? [
              <div key="hint" className="text-muted-foreground text-sm">
                {hint}
              </div>,
            ]
          : [],
        badges: [
          // The same soft `warning`-tone verdict the ledger column and the purchase
          // page show, from the same classifier — never a defect red.
          <ReconciliationBadge key="reconciliation" purchase={purchase} />,
          ...(purchase.orderId
            ? [
                <Row key="order" align="center" gap="xs">
                  <CodeChip>{purchase.orderId}</CodeChip>
                  <OrderIdLink
                    orderUrl={purchase.orderUrl}
                    orderId={purchase.orderId}
                    vendorName={purchase.vendorName}
                  />
                </Row>,
              ]
            : []),
          ...(purchase.date
            ? [
                <Badge key="date" variant="outline">
                  {formatDate(purchase.date)}
                </Badge>,
              ]
            : []),
        ],
        route: entityDetailLink("purchase", purchase.id),
        editLabel: "Open purchase",
      };
    },
  }),
  section({
    id: "financial-settlement-mismatches",
    label: "Settlement",
    select: (p) => p.purchaseFinancialSettlementMismatches,
    problemKeys: ["purchaseFinancialSettlementMismatches"],
    // A mismatch needs review, but does not imply an Expense should be changed.
    coverage: { keys: ["purchaseFinancialSettlementMismatches"] },
    entity: "purchase",
    renderItem: (item) => ({
      title: item.vendorName ?? "Vendor deleted",
      subtitle: `Expenses ${formatCurrency(item.expenseTotal)} · projected ${formatCurrency(item.financialReconciliation.projectedTotal)}`,
      badges: [
        <Badge key="status" variant="warning">
          Settlement mismatch
        </Badge>,
        <Badge key="transactions" variant="outline">
          {item.financialReconciliation.transactionCount} transactions
        </Badge>,
      ],
      route: entityDetailLink("purchase", item.id),
      editLabel: "Open purchase",
    }),
  }),
  section({
    id: "duplicate-spend-candidates",
    label: "Possible duplicates",
    select: (p) => p.duplicateSpendCandidates,
    problemKeys: ["duplicateSpendCandidates"],
    // Advisory, and more so than its neighbours: the match itself is a heuristic,
    // and the remedy destroys a row. No meter — these aren't a fraction of a
    // population, and a count to drive to zero would invite deleting the doubtful
    // ones. The expense is the subject, so the card opens the expense, not the
    // purchase it collides with.
    coverage: { keys: ["duplicateSpendCandidates"] },
    entity: "expense",
    renderItem: (item) => ({
      // Two lump rows can share a name, and the name is the card title.
      key: item.id,
      title: item.expenseName,
      subtitle: `${formatCurrency(item.cost)} · matches ${item.vendorName ?? "deleted vendor"} ${
        item.matchedOn === "stated_total" ? "stated total" : "expense total"
      } of ${formatCurrency(
        item.matchedOn === "stated_total" && item.purchaseStatedTotal !== null
          ? item.purchaseStatedTotal
          : item.purchaseExpenseTotal,
      )} across ${item.purchaseExpenseCount} line${item.purchaseExpenseCount === 1 ? "" : "s"}`,
      badges: [
        <Badge key="status" variant="warning">
          Possible duplicate
        </Badge>,
        <Badge key="purchase" variant="outline">
          {item.purchaseId}
        </Badge>,
        ...(item.dayDelta > 0
          ? [
              <Badge key="gap" variant="outline">
                {item.dayDelta} day{item.dayDelta === 1 ? "" : "s"} apart
              </Badge>,
            ]
          : []),
        ...(item.alternateMatchCount > 0
          ? [
              <Badge key="alternates" variant="outline">
                +{item.alternateMatchCount} weaker match
                {item.alternateMatchCount === 1 ? "" : "es"}
              </Badge>,
            ]
          : []),
      ],
      route: entityDetailLink("expense", item.id),
      editLabel: "Open expense",
    }),
  }),
  section({
    id: "duplicate-financial-transaction-source-refs",
    label: "Duplicate transaction refs",
    select: (p) => p.duplicateFinancialTransactionSourceRefs,
    problemKeys: ["duplicateFinancialTransactionSourceRefs"],
    entity: "financialTransaction",
    renderItem: (item) => ({
      title: `${item.source}: ${item.externalId}`,
      details: [item.transactionIds.join(", ")],
    }),
  }),
  section({
    id: "duplicate-financial-account-source-aliases",
    label: "Duplicate account aliases",
    select: (p) => p.duplicateFinancialAccountSourceAliases,
    problemKeys: ["duplicateFinancialAccountSourceAliases"],
    entity: "financialAccount",
    renderItem: (item) => ({
      title: `${item.source}: ${item.externalAccountId}`,
      details: [item.accountIds.join(", ")],
    }),
  }),
  section({
    id: "financial-transaction-allocation-defects",
    label: "Broken settlement allocations",
    select: (p) => p.financialTransactionAllocationDefects,
    problemKeys: ["financialTransactionAllocationDefects"],
    entity: "financialTransaction",
    renderItem: (item) => ({
      title: `${item.id} · ${item.reasons.join(", ")}`,
      details: [
        `${item.kind} ${item.amount.toFixed(2)} — ${item.allocationCount} allocation${
          item.allocationCount === 1 ? "" : "s"
        } totalling ${item.allocatedTotal.toFixed(2)}`,
        ...(item.purchaseIds.length ? [item.purchaseIds.join(", ")] : []),
      ],
      route: entityDetailLink("financialTransaction", item.id),
      editLabel: "Open transaction",
    }),
  }),
  section({
    id: "invalid-financial-json",
    label: "Invalid finance JSON",
    select: (p) => p.invalidFinancialJson,
    problemKeys: ["invalidFinancialJson"],
    entity: "financialAccount",
    renderItem: (item) => ({
      title: `${item.entity} · ${item.field}`,
      subtitle: item.id,
      details: [item.message],
    }),
  }),
  section({
    id: "incomplete-statement-imports",
    label: "Incomplete statement imports",
    select: (p) => p.incompleteStatementImports,
    problemKeys: ["incompleteStatementImports"],
    entity: "financialAccount",
    renderItem: (item) => ({
      title: `${item.source} · ${item.label}`,
      subtitle: item.fingerprint,
      details: [
        `${item.rowCountStored} of ${item.rowCountDeclared} rows stored — ${
          item.rowCountDeclared - item.rowCountStored
        } missing`,
      ],
    }),
  }),
];

export const PROBLEM_SECTIONS: SectionsClaimingEveryCoverageKey<
  typeof DECLARED_SECTIONS
> = DECLARED_SECTIONS;
