import type { Entity } from "@cubby/schemas/entity";
import type { ReferentialLivenessViolation } from "@cubby/schemas/entity-integrity";
import type { ShortcodeEntity } from "@cubby/schemas/entity-manifest";
import { displayGtin } from "@cubby/schemas/external-id";
import {
  type AllProblems,
  type CoverageProblemKey,
  type CoverageTotals,
  type FinancialTransactionAllocationDefect,
  type KitCountedTwice,
  type ImportFindingProblem,
  type ImageProcessingProblem,
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
  Scale,
  ScanBarcode,
  Sparkles,
  Store,
  Unlink,
  Wrench,
} from "lucide-react";
import type { ReactNode } from "react";

import { useActionMutation } from "~/app/_components/hooks/useActionMutation";
import { OrderIdLink } from "~/app/_components/OrderIdLink";
import { AuditedHint } from "~/app/inventory/session/_components/AuditedHint";
import { mealDateLabel } from "~/app/meals/meal-format";
import { product as productOperations } from "~/app/products/product.functions";
import { attentionEvidence } from "~/app/projects/attention-presentation";
import { formatDateWithYear } from "~/app/projects/project-formatting";
import {
  ReconciliationStatus,
  reconciliationDelta,
} from "~/app/purchases/purchase-reconciliation";
import { Row } from "~/components/layout";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
  EntityIcon,
  entities,
  entityDetailLink,
  entityLabel,
  entityPluralLabel,
  isBrowserRoutedEntity,
} from "~/entities/entities";
import { humanize } from "~/entities/filters";
import type { ProblemQuery } from "~/entities/problem-query";
import { problemQuery } from "~/entities/problem-registry";
import { maintenance } from "~/lib/maintenance.functions";
import { countLabel } from "~/lib/pluralize";
import { problems as problemOperations } from "~/lib/problems.functions";
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

type ProblemSectionEntry<K extends CoverageProblemKey = CoverageProblemKey> = {
  id: string;
  label: string;
  count: (problems: AllProblems) => number;
  node: (
    problems: AllProblems,
    totals: CoverageTotals | undefined,
  ) => ReactNode;
  coverage?: ProblemSectionDeclaredCoverage<K>;
  problemKeys?: readonly ProblemKey[];
};

const isHeaderActionFactory = <T,>(
  value: ReactNode | ((items: T[], count: number) => ReactNode),
): value is (items: T[], count: number) => ReactNode =>
  typeof value === "function";

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
  title?: string;
  description?: string;
  emptyMessage?: string;
  icon?: LucideIcon;
  entity?: Entity;
  renderItem: (item: T) => RenderedProblemItem;
  groupBy?: (items: T[]) => Record<string, T[]>;
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
  /** See `ProblemSection`'s `hideWhenEmpty` — for a regression guard, not a backlog. */
  hideWhenEmpty?: boolean;
}): ProblemSectionEntry<K> {
  const iconProp: IconProp = config.entity
    ? { entity: config.entity }
    : config.icon
      ? { icon: config.icon }
      : (() => {
          throw new Error(`Problem section "${config.id}" needs an icon`);
        })();
  const canonicalKey =
    config.problemKeys?.length === 1 ? config.problemKeys[0] : undefined;
  const canonicalPresentation = canonicalKey
    ? problemQuery(canonicalKey)
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
          hideWhenEmpty={config.hideWhenEmpty}
          renderItem={config.renderItem}
          groupBy={config.groupBy}
          assembly={problemAssembly(
            config.problemKeys,
            problems,
            problems.conversionCoverageFreshness,
          )}
          coverage={resolveCoverage(config.coverage, totals)}
          headerAction={
            config.headerAction &&
            (isHeaderActionFactory(config.headerAction)
              ? config.headerAction(items, count)
              : config.headerAction)
          }
        />
      );
    },
  };
}

function customSection<T, K extends CoverageProblemKey = never>(def: {
  id: string;
  label: string;
  select: (problems: AllProblems) => readonly T[];
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
  const apply = useActionMutation({
    mutationFn: productOperations.applyUpcData.mutationOptions,
    success: `Updated ${product.name} from UPC`,
    // The whole problems.* path is always invalidated by the hook (which also
    // feeds the navbar badge count); add the product/recipe lists (price feeds
    // cost).
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

function ImportFindingActions({ finding }: { finding: ImportFindingProblem }) {
  const resolve = useActionMutation({
    mutationFn: problemOperations.resolveImportFinding.mutationOptions,
    success: (result) =>
      result.status === "applied"
        ? "Applied import correction"
        : "Dismissed import finding",
  });
  const canApply =
    finding.proposedFix !== null &&
    finding.proposedFix.kind !== "receive_purchase";
  return (
    <Row className="gap-2">
      {canApply ? (
        <Button
          size="sm"
          onClick={() => resolve.mutate({ id: finding.id, action: "apply" })}
          disabled={resolve.isPending}
        >
          {resolve.isPending ? "Applying…" : "Apply fix"}
        </Button>
      ) : null}
      <Button
        size="sm"
        variant="outline"
        onClick={() => resolve.mutate({ id: finding.id, action: "dismiss" })}
        disabled={resolve.isPending}
      >
        Dismiss
      </Button>
    </Row>
  );
}

function MissingEmbeddingsBackfillAction() {
  const backfill = useActionMutation({
    mutationFn: maintenance.settleAwaitingWork.mutationOptions,
    success: (data) =>
      data.publishedEmbeddingTasks > 0
        ? `Published ${countLabel(data.publishedEmbeddingTasks, "embedding refresh")}.`
        : "No embeddings needed publishing.",
  });
  return (
    <Button
      size="sm"
      onClick={() => backfill.mutate(undefined)}
      disabled={backfill.isPending}
    >
      {backfill.isPending ? "Publishing…" : "Backfill all"}
    </Button>
  );
}

function referentialLivenessGroup(v: ReferentialLivenessViolation): string {
  return `${entityPluralLabel(v.targetEntity)} · ${v.edgeKey}`;
}

function edgeKeyDetail(edgeKey: string): ReactNode {
  return (
    <div key="edge" className="font-mono text-xs text-muted-foreground">
      {edgeKey}
    </div>
  );
}

function sourceDetail(sourceTable: string, sourceId: string): ReactNode {
  return (
    <Row
      key="source"
      align="center"
      gap="xs"
      className="text-sm text-muted-foreground"
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
      className="flex items-center gap-1 font-sans tracking-normal normal-case"
    >
      <EntityIcon entity={v.targetEntity} colored className="size-3" />
      {entityLabel(v.targetEntity)} {v.targetId.slice(0, 8)}
    </Badge>
  );
}

const TRACKER_GROUPS: { type: ProjectAttentionType; title: string }[] = [
  { type: "overdue_task", title: "Overdue tasks" },
  { type: "blocked_work", title: "Blocked with no next action" },
  { type: "stalled_project", title: "Stalled projects" },
  { type: "past_due_planned_expense", title: "Planned expenses past due" },
  { type: "missing_budget", title: "Missing a cost estimate" },
  { type: "unclassified_expense", title: "Unclassified expenses" },
  { type: "date_window_drift", title: "Date window drift" },
];

const TRACKER_GROUP_TITLE = {
  overdue_task: "Overdue tasks",
  blocked_work: "Blocked with no next action",
  stalled_project: "Stalled projects",
  past_due_planned_expense: "Planned expenses past due",
  missing_budget: "Missing a cost estimate",
  unclassified_expense: "Unclassified expenses",
  date_window_drift: "Date window drift",
} satisfies Record<ProjectAttentionType, string>;

function missingBudgetDetail(item: ProjectAttentionItem): ReactNode[] {
  if (item.type !== "missing_budget") return [];
  const { actualSpend, committedSpend } = item.facts;
  if (actualSpend <= 0 || committedSpend <= 0) return [];
  return [
    <div key="split" className="text-sm text-muted-foreground">
      {formatCurrency(actualSpend, 0)} actual +{" "}
      {formatCurrency(committedSpend, 0)} committed
    </div>,
  ];
}

function renderTrackerItem(item: ProjectAttentionItem): RenderedProblemItem {
  return {
    key: item.key,
    title: item.name,
    subtitle: attentionEvidence(item),
    tone: item.severity,
    // Only drift gets a badge, and it is load-bearing: it is the sole thing
    // distinguishing the two rows one project can emit under this rule.
    badges:
      item.type === "date_window_drift"
        ? [
            <Badge key="side" variant="outline">
              {item.facts.side}
            </Badge>,
          ]
        : [],
    details: missingBudgetDetail(item),
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

const variantSubtitle = (
  v: Pick<LabelVariant, "count" | "canonical" | "canonicalCount">,
  noun: string,
) =>
  `${v.count} ${noun}${v.count === 1 ? "" : "s"} — "${v.canonical}" has ${
    v.canonicalCount
  }`;

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

  if (item.kind === "titleSize") {
    // Show the exact substring the proposal came from. The reader is being
    // asked to confirm a machine reading of their own product name, so the
    // evidence belongs on the card rather than one click away — and a wrong
    // parse is only obvious next to the words it came from.
    return {
      ...base,
      badges: [
        <Badge key="proposed" variant="outline" className="w-fit font-mono">
          {`1 each = ${item.proposed.value} ${item.proposed.unit}`}
        </Badge>,
      ],
      details: [`Read from the title: “${item.token}”`],
      inlineFix: inlineFix("Add this size"),
    };
  }

  if (item.kind === "none" && item.isIngredient) {
    return {
      ...base,
      customActions: <WorkbenchFixLink ingredientId={item.ingredientId} />,
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
            className="text-sm text-muted-foreground"
          >
            Group {i + 1}: {island.units.join(", ")}
          </div>
        )),
      ],
    };
  }

  return {
    ...base,
    inlineFix: inlineFix("Set price"),
    details: [<CoverageChips key="cov" covered={[]} />],
  };
}

const mealDay = (meal: { date: string }): string =>
  `${mealDateLabel(meal)}, ${meal.date.slice(0, 4)}`;

function shortcodeChips(
  key: string,
  label: string,
  entity: "financialTransaction" | "financialAccount" | "purchase",
  ids: readonly string[],
): ReactNode {
  return (
    <Row key={key} align="center" gap="xs" wrap className="text-sm">
      <span className="text-muted-foreground">{label}</span>
      {ids.map((id) => (
        <Badge
          key={id}
          variant="outline"
          className="font-sans tracking-normal normal-case"
          render={<Link {...entityDetailLink(entity, id)} />}
        >
          {id}
        </Badge>
      ))}
    </Row>
  );
}

const ALLOCATION_DEFECT_LABEL = {
  "sum-mismatch": "allocations don't sum to the transaction",
  "non-settlement-kind": "allocations on a non-settlement kind",
  "kind-sign-violation": "amount sign is wrong for its kind",
  "allocation-sign-mismatch":
    "an allocation's sign differs from the transaction",
} satisfies Record<
  FinancialTransactionAllocationDefect["reasons"][number],
  string
>;

function unpricedSubtitle(product: ProductMissingPrice): string {
  const qty = product.inventoryQuantity;
  return `${byManufacturer(product.manufacturer)} · ${qty} ${qty === 1 ? "unit" : "units"} unvalued`;
}

function soldButStockedSubtitle(product: SoldButStillStocked): string {
  const live = product.liveQuantity;
  const stocked = `${live} still on a shelf`;
  return `${byManufacturer(product.manufacturer)} · sold ${product.soldQuantity}, ${stocked} · ${formatCurrency(Math.abs(product.proceeds))} recovered`;
}

function kitCountedTwiceSubtitle(product: KitCountedTwice): string {
  const bought = `${product.expectedUnits} bought`;
  return `${byManufacturer(product.manufacturer)} · ${product.ownUnits} stocked as itself, plus its parts · more than the ${bought}`;
}

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

function unlinkedExitSubtitle(row: UnlinkedExitExpense): string {
  return [
    row.vendorName,
    formatCurrency(Math.abs(row.cost)),
    row.date ? `sold ${formatDateWithYear(row.date)}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

function purchaselessExitSubtitle(row: PurchaselessExitExpense): string {
  return [
    row.projectName,
    formatCurrency(Math.abs(row.cost)),
    row.date ? `sold ${formatDateWithYear(row.date)}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

function outsideOwnershipSubtitle(row: ToolUsedOutsideOwnership): string {
  // `projectBoundary` already has the detector's grace period applied, so it is
  // not the project's stated date — say "grace" rather than let the reader
  // compare it against the project page and conclude the card is wrong.
  const tool = formatDateWithYear(row.toolDate);
  const boundary = `${formatDateWithYear(row.projectBoundary)} (incl. grace)`;
  return row.conflict === "acquired_after_end"
    ? `${byManufacturer(row.manufacturer)} · acquired ${tool}, after ${row.projectName} ended ${boundary}`
    : `${byManufacturer(row.manufacturer)} · disposed of ${tool}, before ${row.projectName} started ${boundary}`;
}

function entityBadge(
  entity: ShortcodeEntity,
  ref: { id: string; name: string },
): ReactNode {
  const routed = isBrowserRoutedEntity(entity);
  return (
    <Badge
      key={ref.id}
      variant="outline"
      // Free-form entity names — opt out of the mono-uppercase stamp.
      className="flex items-center gap-1 font-sans tracking-normal normal-case hover:bg-accent"
      render={
        routed ? <Link {...entityDetailLink(entity, ref.id)} /> : <span />
      }
    >
      {routed && <EntityIcon entity={entity} colored className="size-3" />}
      {ref.name}
    </Badge>
  );
}

const locationBadges = (
  locations: ProductMissingPrice["locations"],
): ReactNode[] =>
  locations.map((location) => entityBadge("location", location));

function purchaseSubtitle(purchase: PurchaseNotReconciling): string {
  const expenses = `${purchase.expenseCount} ${purchase.expenseCount === 1 ? "expense" : "expenses"}`;
  return `Stated ${formatCurrency(purchase.statedTotal)} · expenses ${formatCurrency(purchase.expenseTotal)} across ${expenses}`;
}

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
    id: "import-findings",
    label: "Purchase imports",
    select: (p) => p.importFindings,
    problemKeys: ["importFindings"],
    icon: AlertTriangle,
    renderItem: (finding) => ({
      key: finding.id,
      title: finding.summary,
      subtitle: `${finding.kind.replaceAll("_", " ")} · ${formatDateWithYear(finding.createdAt.toISOString().slice(0, 10))}`,
      route: finding.purchaseId
        ? entityDetailLink("purchase", finding.purchaseId)
        : undefined,
      customActions: <ImportFindingActions finding={finding} />,
    }),
  }),
  section({
    id: "duplicates",
    label: "Duplicates",
    select: (p) => p.duplicateInventory,
    problemKeys: ["duplicateInventory"],
    entity: "product",
    renderItem: (product) => ({
      title: product.name,
      subtitle: [
        byManufacturer(product.manufacturer),
        `${product.locations.length} entries across ${product.locations.length === 1 ? "1 location" : `${product.locations.length} locations`}`,
        product.expectedQuantity != null
          ? `${product.expectedQuantity} expected`
          : null,
      ]
        .filter(Boolean)
        .join(" · "),
      badges: locationBadges(product.locations),
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
      subtitle: `${dupe.products.length} products share this part number`,
      badges: dupe.products.map((p) => entityBadge("product", p)),
      details: [
        ...dupe.products.map((p) => (
          <div key={p.id} className="text-sm text-muted-foreground">
            {[
              p.name,
              p.gtins.length
                ? p.gtins.map(displayGtin).join(", ")
                : "no barcode",
              p.sources.length ? p.sources.join(", ") : "no external ids",
            ].join(" · ")}
          </div>
        )),
        <Link
          key="recommendation-workbench"
          to="/recommendations/workbench"
          search={{
            kind: "duplicate-product",
            source: dupe.products[0]?.id ?? "PRD-0000",
          }}
          className="text-sm underline underline-offset-2"
        >
          Review in Recommendations Workbench
        </Link>,
      ],
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
    id: "kits-counted-twice",
    label: "Counted twice",
    select: (p) => p.kitsCountedTwice,
    problemKeys: ["kitsCountedTwice"],
    entity: "product",
    renderItem: (product) => ({
      title: product.name,
      subtitle: kitCountedTwiceSubtitle(product),
      route: entityDetailLink("product", product.id),
    }),
  }),
  section({
    id: "unlinked-exit-expenses",
    label: "Productless disposal lines",
    select: (p) => p.unlinkedExitExpenses,
    problemKeys: ["unlinkedExitExpenses"],
    entity: "expense",
    coverage: { keys: ["unlinkedExitExpenses"] },
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
    coverage: { keys: ["negativeExpectedQuantity"] },
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
    id: "title-derived-sizes",
    label: "Size in the title",
    // Its own section rather than a fourth kind inside "Unit coverage", even
    // though it shares that section's item type and inline fix: these rows are
    // classed `coverage` and those three are `defect`, and a section must
    // render one class — mixing them puts rows in a group that contradicts how
    // they are counted.
    select: (p) =>
      buildUnitCoverageItems([], [], [], p.productsWithTitleDerivableSize),
    problemKeys: ["productsWithTitleDerivableSize"],
    totalKey: "productsWithTitleDerivableSize",
    // No meter: the denominator would be "every product that could ever state a
    // size in its name", which is not a knowable population.
    coverage: { keys: ["productsWithTitleDerivableSize"] },
    icon: Scale,
    title: "Sizes stated in the title but not recorded",
    description:
      "A food or ingredient product name states a size, but nothing records it — so no comparable unit price can be shown. Check each one describes ONE unit before accepting: titles carrying a pack count are excluded, because they read 6-12x too small.",
    emptyMessage:
      "Every food or ingredient product that states a size in its name has it recorded.",
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
      // Recipe count is how much this gap costs — it belongs on the identity
      // line, like every other section's evidence, not in a detail row below.
      subtitle: `Used in ${ing.recipeCount} recipe${ing.recipeCount === 1 ? "" : "s"} · no product to price it`,
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
      // The finding is "no recipe references this". Creation age was standing in
      // for it, which is a different fact and never said the thing being claimed.
      subtitle: "Used in no recipes",
      details: [createdAgoDetail(ing.createdAt)],
      badges: ing.products.map((prod) => entityBadge("product", prod)),
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
      subtitle: "Used in no recipes · no product attached",
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
      // The recount age is the finding, so it leads. `AuditedHint` renders it
      // as a node ("never recounted" / "unverified since Mar 2026"), which is
      // why it stays a detail rather than a plain-string subtitle.
      details: [
        <AuditedHint
          key="recount"
          at={loc.lastBulkInventory}
          label="recounted"
          className="text-sm text-foreground"
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
      badges: [entityBadge("location", item.location)],
      details: [createdAgoDetail(item.createdAt)],
      route: entityDetailLink("inventory", item.id),
      editLabel: "Open inventory entry",
      customActions: (
        <Row gap="sm">
          <RecountLink shortcode={item.location.id} />
          <Link
            to="/recommendations/workbench"
            search={{ kind: "placement", inventory: item.id }}
            className="text-sm underline underline-offset-2"
          >
            Review placement recommendation
          </Link>
        </Row>
      ),
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
        // This price is what the unit WOULD be valued against — the row exists
        // precisely because no conversion reaches it. Stated bare it read as the
        // applicable price, i.e. as though nothing were wrong.
        <Badge key="price" variant="outline">
          Unreachable {formatCurrency(item.effectivePrice)} each
        </Badge>,
      ],
      route: entityDetailLink("product", item.product.id),
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
      badges: product.primaryGtin
        ? [<CodeChip key="upc">{displayGtin(product.primaryGtin)}</CodeChip>]
        : [],
      route: entityDetailLink("product", product.id),
    }),
  }),
  section({
    id: "image-processing",
    label: "Image processing",
    select: (p) => p.imageProcessingIssues,
    problemKeys: ["imageProcessingIssues"],
    coverage: { keys: ["imageProcessingIssues"] },
    entity: "image",
    renderItem: (image: ImageProcessingProblem) => ({
      title: image.filename,
      subtitle:
        image.processingIssue === "failed"
          ? "Processing failed"
          : "Cutout eligibility needs review",
      badges: [
        <Badge key="issue" variant="warning">
          {image.processingIssue === "failed" ? "Failed" : "Needs review"}
        </Badge>,
      ],
      route: entityDetailLink("image", image.id),
      editLabel: "Open image",
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
      subtitle: `${location.imageCount} ${location.imageCount === 1 ? "photo" : "photos"} to describe from`,
      badges: [
        <Badge key="type" variant="outline" className="capitalize">
          {location.type}
        </Badge>,
      ],
      route: entityDetailLink("location", location.id),
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
      key: `${entity.entityType}:${entity.entityId}`,
      // The WHOLE shortcode. This was `.slice(0, 8)`, copied from the orphaned
      // sibling — where the id really is a uuid and truncating it is right. Here
      // it is a public shortcode, so slicing only risked cutting a real code in
      // half for no gain.
      title: entity.entityId,
      subtitle: `${entities[entity.entityType].label} · not in the search index`,
      // Live entity ⇒ always resolvable to a real page, unlike the orphaned
      // side of this pair — see the note on `entityMissingEmbeddingSchema`.
      route: entityDetailLink(entity.entityType, entity.entityId),
    }),
  }),
  section({
    id: "weight-sold-products",
    label: "Weight-sold, no weight mapping",
    select: (p) => p.weightSoldProducts,
    problemKeys: ["weightSoldProducts"],
    entity: "product",
    // Coverage, but with no meter: the denominator would be "products the
    // household buys by weight", which is exactly what this detector is
    // inferring — there is no independently known population to be a fraction
    // of. Same reason `unvalued-buckets` declares coverage without one.
    coverage: { keys: ["weightSoldProducts"] },
    renderItem: (product) => ({
      title: product.name,
      // The spread IS the evidence, so the card shows it rather than asserting
      // "sold by weight" and asking the reader to take that on trust.
      subtitle: `${product.lineCount} priced lines from ${formatCurrency(
        product.lowUnitCost,
      )} to ${formatCurrency(product.highUnitCost)} each — needs a weight-to-money mapping`,
      badges: product.ingredientId
        ? [
            // Only a linked product can mis-cost a recipe; unlinked ones are
            // just an unusable per-each price.
            <Badge key="linked" variant="outline">
              Used by a recipe
            </Badge>,
          ]
        : [],
      route: entityDetailLink("product", product.id),
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
      // The detector returns only {id, name}, so the card cannot yet name WHICH
      // sub-recipe went missing — but it can at least state the finding rather
      // than leaving a card that is a title and a button.
      subtitle: "References a sub-recipe that has been deleted",
      route: entityDetailLink("recipe", recipe.id),
    }),
  }),
  section({
    id: "partially-imported-cookbooks",
    label: "Partial cookbooks",
    select: (p) => p.partiallyImportedCookbooks,
    problemKeys: ["partiallyImportedCookbooks"],
    entity: "cookbook",
    renderItem: (cookbook) => ({
      title: cookbook.name,
      subtitle: `${cookbook.recipeCount} / ${cookbook.sourceRecipeCount} imported · ${cookbook.missingRecipeCount} missing`,
      route: entityDetailLink("cookbook", cookbook.id),
      editLabel: "Open cookbook",
    }),
  }),
  section({
    id: "understated-cost-meals",
    label: "Understated cost",
    select: (p) => p.understatedCostMeals,
    problemKeys: ["understatedCostMeals"],
    entity: "meal",
    renderItem: (meal) => {
      const recipes = `${meal.recipeCount} recipe${
        meal.recipeCount === 1 ? "" : "s"
      } with unpriced ingredients`;
      return {
        title: meal.name ?? mealDay(meal),
        subtitle: meal.name ? `${mealDay(meal)} · ${recipes}` : recipes,
        details: meal.affectedRecipes.map((recipe) => (
          <Link
            key={recipe.id}
            to="/recipes/$shortcode"
            params={{ shortcode: recipe.id }}
            search={{ costingGap: true }}
            className="block text-sm text-muted-foreground underline underline-offset-2 hover:text-foreground"
          >
            {recipe.name} — {recipe.costCovered} of {recipe.ingredientCount}{" "}
            ingredients priced
          </Link>
        )),
        route: entityDetailLink("meal", meal.id),
      };
    },
  }),
  section({
    id: "referential-liveness",
    label: "Dangling refs",
    select: (p) => p.referentialLivenessViolations,
    problemKeys: ["referentialLivenessViolations"],
    icon: Unlink,
    // Regression guard: healthy is the overwhelming common case, so don't
    // spend a permanent card on "nothing found".
    hideWhenEmpty: true,
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
    id: "dependency-cycles",
    label: "Dependency cycles",
    select: (p) => p.dependencyCycles,
    problemKeys: ["dependencyCycles"],
    icon: Network,
    // Regression guard: healthy is the overwhelming common case, so don't
    // spend a permanent card on "nothing found".
    hideWhenEmpty: true,
    groupBy: (items) =>
      groupBy(items, (cycle) =>
        cycle.entity === "project" ? "Projects" : "Tasks",
      ),
    renderItem: (cycle) => ({
      key: `${cycle.entity}-${cycle.path.join("-")}`,
      title: cycle.description,
      details: [
        <div key="path" className="font-mono text-xs text-muted-foreground">
          {cycle.path.join(" → ")}
        </div>,
      ],
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
              <div key="hint" className="text-sm text-muted-foreground">
                {hint}
              </div>,
            ]
          : [],
        badges: [
          // The same soft `warning`-tone verdict the ledger column and the purchase
          // page show, from the same classifier — never a defect red.
          <ReconciliationStatus key="reconciliation" purchase={purchase} />,
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
                  Ordered {formatDateWithYear(purchase.date)}
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
        // The gap itself, signed — the finding, which the card previously made
        // the reader compute from the two totals in the subtitle. The old badge
        // here just repeated the section heading.
        <Badge key="delta" variant="warning">
          {item.financialReconciliation.delta > 0 ? "Over by " : "Short by "}
          {formatCurrency(Math.abs(item.financialReconciliation.delta))}
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
      details: [
        // Name both days. "3 days apart" alone is a claim the reader can't
        // check without opening both records — exactly the work the card is
        // meant to save.
        <div key="dates" className="text-sm text-muted-foreground">
          {[
            item.expenseDate
              ? `Expense ${formatDateWithYear(item.expenseDate)}`
              : "Expense undated",
            item.purchaseDate
              ? `purchase ${formatDateWithYear(item.purchaseDate)}`
              : "purchase undated",
          ].join(" · ")}
        </div>,
      ],
      badges: [
        // No "Possible duplicate" stamp — that is the section's own title, on
        // every card in it. Labeled but deliberately NOT a link: the expense is
        // the actionable row and the purchase is only context, so every route
        // out of this card points at the expense (see the section note above).
        <Badge key="purchase" variant="outline">
          Purchase {item.purchaseId}
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
      key: `${item.source}:${item.externalId}`,
      // The reference IS the subject here — these rows have no other identity —
      // so it leads, and the subtitle says what is wrong with it.
      title: item.externalId,
      subtitle: `${item.transactionIds.length} transactions claim this ${item.source} reference`,
      details: [
        shortcodeChips(
          "txns",
          "Transactions",
          "financialTransaction",
          item.transactionIds,
        ),
      ],
    }),
  }),
  section({
    id: "duplicate-financial-account-source-aliases",
    label: "Duplicate account aliases",
    select: (p) => p.duplicateFinancialAccountSourceAliases,
    problemKeys: ["duplicateFinancialAccountSourceAliases"],
    entity: "financialAccount",
    renderItem: (item) => ({
      key: `${item.source}:${item.externalAccountId}`,
      title: item.externalAccountId,
      subtitle: `${item.accountIds.length} accounts claim this ${item.source} alias`,
      details: [
        shortcodeChips(
          "accounts",
          "Accounts",
          "financialAccount",
          item.accountIds,
        ),
      ],
    }),
  }),
  section({
    id: "financial-transaction-allocation-defects",
    label: "Broken settlement allocations",
    select: (p) => p.financialTransactionAllocationDefects,
    problemKeys: ["financialTransactionAllocationDefects"],
    entity: "financialTransaction",
    renderItem: (item) => ({
      title: item.name ?? item.id,
      subtitle: [
        formatCurrency(item.amount),
        `${item.allocationCount} allocation${item.allocationCount === 1 ? "" : "s"} totalling ${formatCurrency(item.allocatedTotal)}`,
        item.postedDate
          ? `posted ${formatDateWithYear(item.postedDate)}`
          : null,
      ]
        .filter(Boolean)
        .join(" · "),
      badges: [
        <Badge key="kind" variant="outline">
          {item.kind}
        </Badge>,
      ],
      details: [
        // The reasons in words. The raw enum slugs (`sum-mismatch`,
        // `kind-sign-violation`) were reaching the page verbatim.
        <div key="reasons" className="text-sm text-destructive">
          {item.reasons
            .map((reason) => ALLOCATION_DEFECT_LABEL[reason] ?? reason)
            .join("; ")}
        </div>,
        ...(item.purchaseIds.length
          ? [
              shortcodeChips(
                "purchases",
                "Settles",
                "purchase",
                item.purchaseIds,
              ),
            ]
          : []),
      ],
      route: entityDetailLink("financialTransaction", item.id),
    }),
  }),
  section({
    id: "invalid-financial-json",
    label: "Invalid finance JSON",
    select: (p) => p.invalidFinancialJson,
    problemKeys: ["invalidFinancialJson"],
    entity: "financialAccount",
    renderItem: (item) => ({
      key: `${item.id}:${item.field}`,
      // The record, then which of its fields won't parse — rather than a schema
      // type name plus a column name, with the one actionable id demoted to an
      // unlabeled subtitle.
      title: item.id,
      subtitle: `Stored ${humanize(item.field).toLowerCase()} no longer parses`,
      details: [
        <div key="message" className="text-sm text-muted-foreground">
          {item.message}
        </div>,
      ],
      route:
        item.entity === "financialAccount"
          ? entityDetailLink("financialAccount", item.id)
          : entityDetailLink("financialTransaction", item.id),
    }),
  }),
  section({
    id: "incomplete-statement-imports",
    label: "Incomplete statement imports",
    select: (p) => p.incompleteStatementImports,
    problemKeys: ["incompleteStatementImports"],
    entity: "financialAccount",
    renderItem: (item) => ({
      key: item.fingerprint,
      title: item.label,
      // The shortfall, which was buried in `details` while the subtitle carried
      // a raw content hash nobody can read or act on.
      subtitle: `${item.rowCountStored} of ${item.rowCountDeclared} rows stored — ${
        item.rowCountDeclared - item.rowCountStored
      } missing`,
      badges: [
        <Badge key="source" variant="outline">
          {item.source}
        </Badge>,
      ],
    }),
  }),
];

export const PROBLEM_SECTIONS: SectionsClaimingEveryCoverageKey<
  typeof DECLARED_SECTIONS
> = DECLARED_SECTIONS;
