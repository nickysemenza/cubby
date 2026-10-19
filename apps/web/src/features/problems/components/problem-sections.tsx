import type { Entity } from "@cubby/schemas/entity";
import type { ReferentialLivenessViolation } from "@cubby/schemas/entity-integrity";
import type { ShortcodeEntity } from "@cubby/schemas/entity-manifest";
import { displayGtin } from "@cubby/schemas/external-id";
import {
  type AllProblems,
  type CoverageProblemKey,
  type CoverageTotals,
  type ProblemKey,
  problemKeysSize,
  TRACKER_PROBLEM_KEY_BY_TYPE,
  type ProblemItem,
  type ProblemRow,
} from "@cubby/schemas/problems";
import type {
  ProjectAttentionItem,
  ProjectAttentionType,
} from "@cubby/schemas/project";
import { humanize, parseShortcode } from "@cubby/shared";
import { countLabel } from "@cubby/shared/pluralize";
import { DownloadIcon } from "@phosphor-icons/react/dist/csr/Download";
import { FunnelIcon } from "@phosphor-icons/react/dist/csr/Funnel";
import { ImageBrokenIcon } from "@phosphor-icons/react/dist/csr/ImageBroken";
import { LinkBreakIcon } from "@phosphor-icons/react/dist/csr/LinkBreak";
import { NetworkIcon } from "@phosphor-icons/react/dist/csr/Network";
import { ScalesIcon } from "@phosphor-icons/react/dist/csr/Scales";
import { SparkleIcon } from "@phosphor-icons/react/dist/csr/Sparkle";
import { StorefrontIcon } from "@phosphor-icons/react/dist/csr/Storefront";
import { WarningIcon } from "@phosphor-icons/react/dist/csr/Warning";
import { WrenchIcon } from "@phosphor-icons/react/dist/csr/Wrench";
import { Link } from "@tanstack/react-router";
import { groupBy } from "es-toolkit";
import type { ElementType, ReactNode } from "react";

import { EntityRefLink } from "~/entity/components/entity-ref-link";
import {
  EntityIcon,
  entities,
  entityDetailLink,
  entityLabel,
  entityPluralLabel,
  isBrowserRoutedEntity,
} from "~/entity/entities";
import { useActionMutation } from "~/entity/hooks/use-action-mutation";
import type { ProblemQuery } from "~/entity/problems/problem-query";
import { problemQuery } from "~/entity/problems/problem-registry";
import { mealDateLabel } from "~/features/meal/meal-format";
import { attentionEvidence } from "~/features/project/attention-presentation";
import {
  ReconciliationStatus,
  reconciliationDelta,
} from "~/features/purchase/purchase-reconciliation";
import { RunFindingActions } from "~/features/purchase/run-finding-actions";
import {
  product as productOperations,
  maintenance,
} from "~/integrations/tanstack-query/generated/catalog.gen";
import { formatCalendarDay, formatTimestamp } from "~/lib/date-format";
import { formatDateSpan } from "~/lib/date-span";
import { formatCurrency } from "~/lib/number-format";
import { toastMutationWarnings } from "~/lib/recompute-summary";
import { DateDisplay } from "~/ui/common/date-display";
import type { Fact } from "~/ui/common/fact-list";
import { Row } from "~/ui/layout";
import { Badge } from "~/ui/primitives/badge";
import { Button } from "~/ui/primitives/button";

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
  type ProblemSectionContext,
  type ProblemSectionCoverage,
  type ProblemSectionKind,
  type RenderedProblemItem,
} from "./problem-section";
import {
  CodeChip,
  createdAgoDetail,
  fact,
  facts,
  manufacturerFact,
  recordFact,
} from "./render-helpers";
import {
  DuplicateProductMergeFix,
  DuplicateAccountAliasFix,
  DuplicateTransactionRefFix,
  DeleteAllOrphanedButton,
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

export type ProblemSectionEntry<
  K extends CoverageProblemKey = CoverageProblemKey,
> = {
  id: string;
  label: string;
  title: string;
  description: string;
  /** What a passing check says about itself. */
  emptyMessage: string;
  icon: ElementType<{ className?: string }>;
  coverage?: ProblemSectionDeclaredCoverage<K>;
  /** Every detector key the section renders; its count is their true size. */
  problemKeys: readonly ProblemKey[];
  /** The rows the section renders — a sample when its lane caps them. */
  rows: (problems: AllProblems) => readonly unknown[];
  count: (problems: AllProblems) => number;
  /** For a regression guard: an empty section isn't listed at all. */
  hideWhenEmpty?: boolean;
  /** The section's own bulk fix, shown beside its heading while it has rows. */
  headerAction?: (problems: AllProblems) => ReactNode;
  node: (
    problems: AllProblems,
    totals: CoverageTotals | undefined,
    kind?: ProblemSectionKind,
  ) => ReactNode;
};

const isHeaderActionFactory = <T,>(
  value: ReactNode | ((items: T[], count: number) => ReactNode),
): value is (items: T[], count: number) => ReactNode =>
  typeof value === "function";

const entityGlyphs = new Map<Entity, ElementType<{ className?: string }>>();

/** A section-heading icon component for an entity, made once per entity. */
function entityGlyph(entity: Entity): ElementType<{ className?: string }> {
  const existing = entityGlyphs.get(entity);
  if (existing) return existing;
  const Glyph = ({ className }: { className?: string }) => (
    <EntityIcon entity={entity} className={className} />
  );
  entityGlyphs.set(entity, Glyph);
  return Glyph;
}

const sectionIcon = (config: IconProp, id: string) => {
  if (config.entity) return entityGlyph(config.entity);
  if (config.icon) return config.icon;
  throw new Error(`Problem section "${id}" needs an icon`);
};

/** Heading copy from the explicit config, else the lone Problem query. */
function sectionCopy(
  id: string,
  problemKeys: readonly ProblemKey[],
  copy: { title?: string; description?: string; emptyMessage?: string },
) {
  const canonical =
    problemKeys.length === 1 ? problemQuery(problemKeys[0]!) : undefined;
  const title = copy.title ?? canonical?.title;
  const description = copy.description ?? canonical?.description;
  const emptyMessage = copy.emptyMessage ?? canonical?.emptyMessage;
  if (!title || !description || !emptyMessage) {
    throw new Error(
      `Problem section "${id}" needs one canonical Problem key or explicit presentation copy`,
    );
  }
  return { title, description, emptyMessage };
}

function section<T, K extends CoverageProblemKey = never>(
  config: {
    id: string;
    label: string;
    select: (problems: AllProblems) => readonly T[];
    /**
     * Every detector key `select` reads. The section's count is their true
     * size (`problemKeysSize`), never `select`'s length — a sampled lane
     * returns a page of rows, and counting the page is what made the summary
     * disagree with the headline.
     */
    problemKeys: readonly ProblemKey[];
    title?: string;
    description?: string;
    emptyMessage?: string;
    renderItem: (item: T) => RenderedProblemItem;
    groupBy?: (items: T[]) => Record<string, T[]>;
    /**
     * A static "fix all" node, or one built from the section's contents.
     *
     * The builder gets the true `count` alongside the rendered `items`, because
     * a sampled section renders only a page — a bulk action wired to `items`
     * would act on twelve and label itself "all".
     */
    headerAction?: ReactNode | ((items: T[], count: number) => ReactNode);
    coverage?: ProblemSectionDeclaredCoverage<K>;
    hideWhenEmpty?: boolean;
  } & IconProp,
): ProblemSectionEntry<K> {
  const { title, description, emptyMessage } = sectionCopy(
    config.id,
    config.problemKeys,
    config,
  );
  const count = (problems: AllProblems) =>
    problemKeysSize(problems, config.problemKeys, problems.sectionTotals);
  return {
    id: config.id,
    label: config.label,
    title,
    description,
    emptyMessage,
    icon: sectionIcon(config, config.id),
    // Must be forwarded, not just closed over by `node` below: the page groups
    // sections by reading THIS field.
    coverage: config.coverage,
    problemKeys: config.problemKeys,
    rows: config.select,
    count,
    hideWhenEmpty: config.hideWhenEmpty,
    headerAction: config.headerAction
      ? (problems) => {
          const action = config.headerAction;
          return isHeaderActionFactory<T>(action)
            ? action([...config.select(problems)], count(problems))
            : action;
        }
      : undefined,
    node: (problems, totals, kind) => {
      const context = problemContext(config.problemKeys, problems);
      return (
        <ProblemSection
          items={[...config.select(problems)]}
          count={count(problems)}
          emptyMessage={emptyMessage}
          renderItem={config.renderItem}
          groupBy={config.groupBy}
          assembly={context.assembly}
          listHref={context.listHref}
          warning={context.warning}
          coverage={resolveCoverage(config.coverage, totals)}
          kind={kind}
          visible={kind === "auto-fix" ? AUTO_FIX_PREVIEW_ROWS : undefined}
        />
      );
    },
  };
}

/** Auto-fix sections preview what the Fix button will touch, not the backlog. */
const AUTO_FIX_PREVIEW_ROWS = 3;

function customSection<T, K extends CoverageProblemKey = never>(
  def: {
    id: string;
    label: string;
    select: (problems: AllProblems) => readonly T[];
    problemKeys: readonly ProblemKey[];
    title?: string;
    description?: string;
    emptyMessage?: string;
    render: (props: {
      items: T[];
      coverage: ProblemSectionCoverage | undefined;
      count: number;
      emptyMessage: string;
      context: ProblemSectionContext;
    }) => ReactNode;
    coverage?: ProblemSectionDeclaredCoverage<K>;
  } & IconProp,
): ProblemSectionEntry<K> {
  const { title, description, emptyMessage } = sectionCopy(
    def.id,
    def.problemKeys,
    def,
  );
  const count = (problems: AllProblems) =>
    problemKeysSize(problems, def.problemKeys, problems.sectionTotals);
  return {
    id: def.id,
    label: def.label,
    title,
    description,
    emptyMessage,
    icon: sectionIcon(def, def.id),
    coverage: def.coverage,
    problemKeys: def.problemKeys,
    rows: def.select,
    count,
    node: (problems, totals) =>
      def.render({
        items: [...def.select(problems)],
        coverage: resolveCoverage(def.coverage, totals),
        count: count(problems),
        emptyMessage,
        context: problemContext(def.problemKeys, problems),
      }),
  };
}

/**
 * A server row's facts, then the records it names grouped by entity so each
 * kind (Location, Product, Vendor) is one aligned column of chips.
 */
function problemRowFacts(row: ProblemRow): Fact[] {
  const named = groupBy(row.badges, (badge) => badge.entity);
  return facts(
    ...row.fields.map((entry) =>
      fact(entry.label, entry.value, entry.tone ?? undefined),
    ),
    ...Object.entries(named).map(([, badges]) =>
      badges[0]
        ? recordFact(
            badges[0].entity,
            badges.map((badge) => ({ id: badge.id, name: badge.label })),
          )
        : null,
    ),
  );
}

const rowBadgeId = (
  row: ProblemRow,
  entity: ShortcodeEntity,
): string | undefined =>
  row.badges.find((b) => b.entity === entity)?.id ?? undefined;

function renderProblemRow(row: ProblemRow): RenderedProblemItem {
  return {
    key: `${row.entity}:${row.id}`,
    title: row.name,
    fields: problemRowFacts(row),
    route: isBrowserRoutedEntity(row.entity)
      ? entityDetailLink(row.entity, row.id)
      : undefined,
    editLabel: `Open ${entityLabel(row.entity).toLowerCase()}`,
  };
}

type RowProblemKey = {
  [K in ProblemKey]: ProblemItem<K> extends ProblemRow ? K : never;
}[ProblemKey];

/**
 * A section over uniform `ProblemRow`s: the server computed the evidence line
 * and badges, so the row is generic. `actions` adds the section's own fix.
 */
function rowSection<K extends CoverageProblemKey = never>(
  key: RowProblemKey,
  config: {
    id: string;
    label: string;
    headerAction?:
      | ReactNode
      | ((items: ProblemRow[], count: number) => ReactNode);
    coverage?: ProblemSectionDeclaredCoverage<K>;
    actions?: (
      row: ProblemRow,
    ) => Pick<RenderedProblemItem, "customActions" | "inlineFix">;
  } & IconProp,
): ProblemSectionEntry<K> {
  const { actions, ...rest } = config;
  return section<ProblemRow, K>({
    ...rest,
    select: (p) => p[key],
    problemKeys: [key],
    renderItem: (row) => ({ ...renderProblemRow(row), ...actions?.(row) }),
  });
}

/**
 * What a section derives from its canonical Problem queries: the "How it works"
 * disclosure, the one exact list behind "+N more", and any stale input.
 */
function problemContext(
  keys: readonly ProblemKey[],
  problems: AllProblems,
): ProblemSectionContext {
  const queries = keys
    .map(problemQuery)
    .filter((query): query is ProblemQuery => query != null);
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
  return {
    assembly: queries.length ? (
      <ProblemAssembly queries={queries} listLocations={listLocations} />
    ) : undefined,
    listHref:
      queries.length === 1 && listLocations.length === 1
        ? listLocations[0]!.location.href
        : undefined,
    warning: queries
      .map((query) => freshnessWarning(query, problems))
      .find((warning) => warning != null),
  };
}

/** A stale or unavailable input, said once in the section it affects. */
function freshnessWarning(
  query: ProblemQuery,
  problems: AllProblems,
): string | undefined {
  if (query.freshness.kind === "projection") {
    const state = problems.conversionCoverageFreshness?.state;
    if (state === "unavailable")
      return "Conversion coverage is partially unavailable; exact product worklists omit unavailable rows until enrichment recovers.";
    if (state === "stale")
      return "Conversion coverage is stale; exact product worklists omit stale rows until the projection is rebuilt.";
  }
  if (query.freshness.kind === "external") {
    const status = problems.upcFreshness?.status;
    if (status === "stale")
      return "UPC refresh was deferred; showing cached proposals where available. Remaining codes will be retried on a later pass.";
    if (status != null && status !== "fresh")
      return "UPC lookup is disabled; proposals cannot be refreshed right now.";
  }
  return undefined;
}

/**
 * "Apply" action for the "Better UPC data available" cards — writes the
 * looked-up fields onto the product in place (manufacturer/price via update +
 * recipe recompute, image via R2 import) without leaving the page. Lives in a
 * component (not `renderItem`) so it can own the mutation hook; the card drops
 * out of the list once the problems queries invalidate.
 */
function UpcApplyAction({
  product,
}: {
  product: ProblemItem<"productsWithBetterUpcData">;
}) {
  const apply = useActionMutation({
    mutationFn: productOperations.applyUpcData.mutationOptions,
    success: `Updated ${product.name} from UPC`,
    onSuccess: (result) => toastMutationWarnings(result.sideEffects),
    // The whole problems.* path is always invalidated by the hook (which also
    // feeds the navbar badge count); add the product/recipe lists (price feeds
    // cost).
  });
  return (
    <Button
      size="sm"
      variant="ghost"
      onClick={() => apply.mutate({ id: product.id, upc: product.upc })}
      disabled={apply.isPending}
    >
      <DownloadIcon className="mr-1 size-3" />
      {apply.isPending ? "Applying…" : "Apply"}
    </Button>
  );
}

function MissingEmbeddingsBackfillAction() {
  const backfill = useActionMutation({
    mutationFn: maintenance.run.mutationOptions,
    success: (data) => (
      <a className="underline" href={`/runs/${encodeURIComponent(data.runId)}`}>
        {data.existing
          ? "Maintenance is already running. View run"
          : "Maintenance started. View run"}
      </a>
    ),
  });
  return (
    <Button
      size="sm"
      onClick={() => backfill.mutate(undefined)}
      disabled={backfill.isPending}
    >
      {backfill.isPending ? "Starting…" : "Run maintenance"}
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
  { type: "spend_below_estimate", title: "Spend below estimate" },
  { type: "unclassified_expense", title: "Unclassified expenses" },
  { type: "date_window_drift", title: "Date window drift" },
];

const TRACKER_GROUP_TITLE = {
  overdue_task: "Overdue tasks",
  blocked_work: "Blocked with no next action",
  stalled_project: "Stalled projects",
  past_due_planned_expense: "Planned expenses past due",
  missing_budget: "Missing a cost estimate",
  spend_below_estimate: "Spend below estimate",
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
    fields: facts(
      fact("Evidence", attentionEvidence(item)),
      item.parentProject &&
        recordFact("project", [item.parentProject], "Project"),
      // Only drift gets a side, and it is load-bearing: it is the sole thing
      // distinguishing the two rows one project can emit under this rule.
      item.type === "date_window_drift" && fact("Side", item.facts.side),
    ),
    tone: item.severity,
    details: missingBudgetDetail(item),
    route: { href: item.href },
    editLabel: `Open ${item.entityKind}`,
  };
}

/**
 * Recounting happens in the native app, so the recount-staleness sections link
 * to the offending location's page rather than to a form.
 */
function OpenLocationLink({ shortcode }: { shortcode: string | undefined }) {
  if (!shortcode) return null;
  return (
    <Button
      size="sm"
      variant="ghost"
      render={<Link to="/locations/$shortcode" params={{ shortcode }} />}
      nativeButton={false}
    >
      Open location
    </Button>
  );
}

function ManufacturerVariantLink({ manufacturer }: { manufacturer: string }) {
  return (
    <Button
      size="sm"
      variant="ghost"
      render={<Link to="/products" search={{ manufacturer }} />}
      nativeButton={false}
    >
      <FunnelIcon className="mr-1 size-3" />
      Show products
    </Button>
  );
}

const variantFacts = (
  v: Pick<
    ProblemItem<"manufacturerSpellingVariants">,
    "count" | "canonical" | "canonicalCount"
  >,
  noun: string,
): Fact[] => [
  fact("This spelling", countLabel(v.count, noun), "warning"),
  fact("Canonical", `"${v.canonical}" · ${countLabel(v.canonicalCount, noun)}`),
];

function WorkbenchFixLink({ ingredientId }: { ingredientId: string | null }) {
  return (
    <Button
      size="sm"
      variant="ghost"
      render={
        <Link
          to="/ingredients/workbench"
          search={ingredientId ? { focus: ingredientId } : {}}
        />
      }
      nativeButton={false}
    >
      <WrenchIcon className="mr-1 size-3" />
      Fix in workbench
    </Button>
  );
}

function renderUnitCoverageItem(item: UnitCoverageItem): RenderedProblemItem {
  const base = {
    title: item.name,
    fields: facts(manufacturerFact(item.manufacturer)),
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

/**
 * Records named only by code, as a fact of code links. A chip would resolve
 * each code's name with its own request; these rows carry codes only.
 */
function shortcodeFact(
  label: string,
  entity: Parameters<typeof entityDetailLink>[0],
  ids: readonly string[],
): Fact {
  return {
    id: `record:${entity}`,
    label,
    value: (
      <span className="inline-flex flex-wrap gap-x-2">
        {ids.map((id) => (
          <Link
            key={id}
            {...entityDetailLink(entity, id)}
            className="font-mono underline-offset-2 hover:underline"
          >
            {id}
          </Link>
        ))}
      </span>
    ),
    title: ids.join(", "),
  };
}

const ALLOCATION_DEFECT_LABEL = {
  "sum-mismatch": "allocations don't sum to the transaction",
  "non-settlement-kind": "allocations on a non-settlement kind",
  "kind-sign-violation": "amount sign is wrong for its kind",
  "allocation-sign-mismatch":
    "an allocation's sign differs from the transaction",
} satisfies Record<
  ProblemItem<"financialTransactionAllocationDefects">["reasons"][number],
  string
>;

function outsideOwnershipFacts(
  row: ProblemItem<"toolsUsedOutsideOwnership">,
): Fact[] {
  // `projectBoundary` already has the detector's grace period applied, so it is
  // not the project's stated date — say "grace" rather than let the reader
  // compare it against the project page and conclude the card is wrong.
  const tool = formatCalendarDay(row.toolDate, "dateShort");
  const boundary = `${formatCalendarDay(row.projectBoundary, "dateShort")} (incl. grace)`;
  const acquired = row.conflict === "acquired_after_end";
  return facts(
    manufacturerFact(row.manufacturer),
    recordFact("project", [{ id: row.projectId, name: row.projectName }]),
    fact(acquired ? "Acquired" : "Disposed of", tool, "warning"),
    fact(acquired ? "Project ended" : "Project started", boundary),
  );
}

function purchaseFacts(
  purchase: ProblemItem<"purchasesNotReconciling">,
): Fact[] {
  return facts(
    fact("Stated", formatCurrency(purchase.statedTotal)),
    fact(
      "Expenses",
      `${formatCurrency(purchase.expenseTotal)} (${countLabel(purchase.expenseCount, "expense")})`,
      "warning",
    ),
  );
}

function purchaseDeltaHint(
  purchase: ProblemItem<"purchasesNotReconciling">,
): string | null {
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

/** Detail route for the record a Run finding is about — a Purchase or an Email. */
const findingTargetRoute = (targetId: string | null) => {
  const target = targetId ? parseShortcode(targetId) : null;
  return target && isBrowserRoutedEntity(target.type)
    ? entityDetailLink(target.type, target.shortcode)
    : undefined;
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
    select: (p) => p.runFindings,
    problemKeys: ["runFindings"],
    icon: WarningIcon,
    renderItem: (finding) => ({
      key: finding.id,
      title: finding.summary,
      fields: facts(
        fact("Kind", humanize(finding.kind)),
        fact("Found", formatTimestamp(finding.createdAt)),
      ),
      route: findingTargetRoute(finding.targetId),
      customActions: <RunFindingActions finding={finding} />,
    }),
  }),
  rowSection("duplicateInventory", {
    id: "duplicates",
    label: "Duplicates",
    entity: "product",
  }),
  section({
    id: "duplicate-products",
    label: "Duplicate products",
    select: (p) => p.duplicateProductIdentities,
    problemKeys: ["duplicateProductIdentities"],
    entity: "product",
    renderItem: (dupe) => ({
      key: dupe.assessmentId,
      title: `${dupe.manufacturer} ${dupe.model}`,
      fields: facts(
        fact(
          "Evidence",
          dupe.identityConflict
            ? "Exact identifier conflicts with verified identity evidence"
            : "An independently assessed Product pair",
          dupe.identityConflict ? "warning" : undefined,
        ),
        recordFact("product", dupe.products, "Products"),
      ),
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
      inlineFix:
        dupe.identityConflict || !dupe.fingerprint
          ? undefined
          : {
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
    // "All" only when every orphan is loaded, so it never means a sample.
    headerAction: (items, count) =>
      items.length > 1 && items.length === count ? (
        <DeleteAllOrphanedButton ids={items.map((product) => product.id)} />
      ) : null,
    renderItem: (product) => ({
      title: product.name,
      fields: facts(manufacturerFact(product.manufacturer)),
      details: [createdAgoDetail(product.createdAt)],
      route: entityDetailLink("product", product.id),
      inlineFix: {
        label: "Delete",
        destructive: true,
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
    id: "unconnected-entities",
    label: "Unconnected",
    select: (p) => p.unconnectedEntities,
    problemKeys: ["unconnectedEntities"],
    icon: LinkBreakIcon,
    renderItem: (item) => ({
      key: `${item.kind}:${item.id}`,
      title: item.name ?? item.id,
      fields: facts(fact("Kind", entityLabel(item.kind))),
      route:
        isBrowserRoutedEntity(item.kind) && item.kind !== "usda-food"
          ? entityDetailLink(item.kind, item.id)
          : undefined,
    }),
  }),
  rowSection("productsMissingPrice", {
    id: "missing-price",
    label: "Unpriced",
    entity: "product",
  }),
  rowSection("soldButStillStocked", {
    id: "sold-but-still-stocked",
    label: "Sold but stocked",
    entity: "product",
  }),
  rowSection("kitsCountedTwice", {
    id: "kits-counted-twice",
    label: "Counted twice",
    entity: "product",
  }),
  rowSection("unlinkedExitExpenses", {
    id: "unlinked-exit-expenses",
    label: "Productless disposal lines",
    entity: "expense",
    coverage: { keys: ["unlinkedExitExpenses"] },
  }),
  rowSection("purchaselessExitExpenses", {
    id: "purchaseless-exit-expenses",
    label: "Credit with no order",
    entity: "expense",
    // No meter: half these rows are correct as they stand, so there is no
    // denominator this is a fraction of — the same reason `unvalued-buckets`
    // declares coverage without one.
    coverage: { keys: ["purchaselessExitExpenses"] },
  }),
  rowSection("negativeExpectedQuantity", {
    id: "negative-expected-quantity",
    label: "Negative expected",
    entity: "product",
    coverage: { keys: ["negativeExpectedQuantity"] },
  }),
  section({
    id: "tools-used-outside-ownership",
    label: "Used before owned",
    select: (p) => p.toolsUsedOutsideOwnership,
    problemKeys: ["toolsUsedOutsideOwnership"],
    entity: "product",
    renderItem: (row) => ({
      title: row.name,
      fields: outsideOwnershipFacts(row),
      route: entityDetailLink("product", row.id),
    }),
  }),
  rowSection("unvaluedBucketProducts", {
    id: "unvalued-buckets",
    label: "Unvalued buckets",
    // Coverage, but with no meter: a misc bucket isn't a fraction of any
    // population, so there's nothing honest to put in a denominator.
    coverage: { keys: ["unvaluedBucketProducts"] },
    entity: "product",
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
    icon: NetworkIcon,
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
    // No meter: the denominator would be "every product that could ever state a
    // size in its name", which is not a knowable population.
    coverage: { keys: ["productsWithTitleDerivableSize"] },
    icon: ScalesIcon,
    title: "Sizes stated in the title but not recorded",
    description:
      "A food or ingredient product name states a size, but nothing records it — so no comparable unit price can be shown. Check each one describes ONE unit before accepting: titles carrying a pack count are excluded, because they read 6-12x too small.",
    emptyMessage:
      "Every food or ingredient product that states a size in its name has it recorded.",
    renderItem: renderUnitCoverageItem,
  }),
  rowSection("ingredientsWithoutProduct", {
    id: "no-product-ingredients",
    label: "No product",
    coverage: {
      keys: ["ingredientsWithoutProduct"],
      meter: {
        total: (t) => t.ingredientsWithoutProduct,
        doneLabel: "linked to a product",
      },
    },
    entity: "ingredient",
    // The workbench can actually create the product; the detail page can't.
    actions: (row) => ({
      customActions: <WorkbenchFixLink ingredientId={row.id} />,
    }),
  }),
  rowSection("unusedIngredientsWithProduct", {
    id: "unused-with-product",
    label: "Unused (has product)",
    entity: "ingredient",
    headerAction: (_items, count) => (
      <DeleteAllUnusedButton
        count={count}
        problemKey="unusedIngredientsWithProduct"
        alsoDeleteProducts
      />
    ),
    actions: (row) => ({
      inlineFix: {
        label: "Delete + product(s)",
        render: (close) => (
          <UnusedIngredientDeleteFix
            id={row.id}
            name={row.name}
            alsoDeleteProducts
            close={close}
          />
        ),
      },
    }),
  }),
  rowSection("unusedIngredientsWithoutProduct", {
    id: "unused-no-product",
    label: "Unused",
    entity: "ingredient",
    headerAction: (_items, count) => (
      <DeleteAllUnusedButton
        count={count}
        problemKey="unusedIngredientsWithoutProduct"
        alsoDeleteProducts={false}
      />
    ),
    actions: (row) => ({
      inlineFix: {
        label: "Delete",
        render: (close) => (
          <UnusedIngredientDeleteFix
            id={row.id}
            name={row.name}
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
    entity: "location",
    title: "Empty locations",
    description:
      "Leaf locations holding no inventory entries. Many are deliberate — a crate of zip ties is photographed and described rather than itemized — so treat this as how much of the house is itemized, not as a list of mistakes.",
    emptyMessage: "All leaf locations have inventory entries.",
    coverage: {
      keys: ["emptyLocations"],
      meter: { total: (t) => t.emptyLocations, doneLabel: "itemized" },
    },
    render: ({ items, coverage, count, emptyMessage, context }) => (
      <EmptyLocationsList
        locations={items}
        coverage={coverage}
        count={count}
        emptyMessage={emptyMessage}
        context={context}
      />
    ),
  }),
  rowSection("staleLocations", {
    id: "stale-recounts",
    label: "Stale recounts",
    coverage: {
      keys: ["staleLocations"],
      meter: { total: (t) => t.staleLocations, doneLabel: "recounted" },
    },
    entity: "location",
    actions: (row) => ({
      customActions: <OpenLocationLink shortcode={row.id} />,
    }),
  }),
  rowSection("neverVerifiedInventory", {
    id: "never-verified",
    label: "Never verified",
    coverage: {
      keys: ["neverVerifiedInventory"],
      meter: { total: (t) => t.neverVerifiedInventory, doneLabel: "verified" },
    },
    entity: "inventory",
    actions: (row) => ({
      customActions: (
        <Row gap="sm">
          <OpenLocationLink shortcode={rowBadgeId(row, "location")} />
          <Link
            to="/recommendations/workbench"
            search={{ kind: "placement", inventory: row.id }}
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
      fields: variantFacts(v, "product"),
      // The route opens one product using this spelling, not the spelling itself.
      shortcode: null,
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
      fields: facts(
        ...variantFacts(v, "purchase"),
        recordFact(
          "vendor",
          [{ id: v.canonicalSampleId, name: v.canonical }],
          "Merge into",
        ),
      ),
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
        total: (t) => t.vendors,
        doneLabel: "with a mini logo",
      },
    },
    icon: StorefrontIcon,
    renderItem: (vendor) => ({
      title: vendor.name,
      fields: facts(
        fact("Website", vendor.website ?? "None recorded"),
        fact("Purchases", String(vendor.purchaseCount)),
        fact("Expense lines", String(vendor.expenseRowCount)),
      ),
      route: entityDetailLink("vendor", vendor.id),
      editLabel: "Open vendor",
      customActions: <VendorLogoFetchAction vendor={vendor} />,
    }),
  }),
  rowSection("unknownParkedItems", {
    id: "unknown-parked",
    label: "Parked in Unknown",
    entity: "inventory",
    // Draining Unknown is a recount rooted there (done in the native app) —
    // same location link the other recount detectors offer.
    actions: (row) => ({
      customActions: (
        <OpenLocationLink shortcode={rowBadgeId(row, "location")} />
      ),
    }),
  }),
  rowSection("inventoryWithoutPricePath", {
    id: "inventory-no-price-path",
    label: "Unvaluable units",
    entity: "inventory",
  }),
  rowSection("productsWithNoImages", {
    id: "images",
    label: "Images",
    coverage: {
      keys: ["productsWithNoImages"],
      meter: {
        total: (t) => t.productsWithNoImages,
        doneLabel: "photographed",
      },
    },
    icon: ImageBrokenIcon,
    headerAction: <BackfillButton {...BACKFILL.fetchUpcImages} />,
  }),
  rowSection("imageProcessingIssues", {
    id: "image-processing",
    label: "Image processing",
    coverage: { keys: ["imageProcessingIssues"] },
    entity: "image",
  }),
  rowSection("locationsWithoutAiDescription", {
    id: "ai-descriptions",
    label: "AI Descriptions",
    icon: SparkleIcon,
    headerAction: <BackfillButton {...BACKFILL.analyzeDescriptions} />,
  }),
  section({
    id: "missing-embeddings",
    label: "Unindexed",
    select: (p) => p.entitiesMissingEmbeddings,
    problemKeys: ["entitiesMissingEmbeddings"],
    icon: WrenchIcon,
    headerAction: <MissingEmbeddingsBackfillAction />,
    renderItem: (entity) => ({
      key: `${entity.entityKind}:${entity.entityId}`,
      // The WHOLE shortcode. This was `.slice(0, 8)`, copied from the orphaned
      // sibling — where the id really is a uuid and truncating it is right. Here
      // it is a public shortcode, so slicing only risked cutting a real code in
      // half for no gain.
      title: entity.entityId,
      fields: facts(
        fact("Kind", entities[entity.entityKind].label),
        fact("Search index", "Missing", "warning"),
      ),
      // Live entity ⇒ always resolvable to a real page, unlike the orphaned
      // side of this pair — see the note on `entityMissingEmbeddingSchema`.
      route: entityDetailLink(entity.entityKind, entity.entityId),
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
      fields: facts(
        fact("Priced lines", String(product.lineCount)),
        fact(
          "Unit cost",
          `${formatCurrency(product.lowUnitCost)} – ${formatCurrency(product.highUnitCost)}`,
          "warning",
        ),
        // Only a linked product can mis-cost a recipe; unlinked ones are just
        // an unusable per-each price.
        product.ingredientId &&
          shortcodeFact("Ingredient", "ingredient", [product.ingredientId]),
      ),
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
      fields: facts(fact("Sub-recipe", "Deleted", "destructive")),
      route: entityDetailLink("recipe", recipe.id),
    }),
  }),
  section({
    id: "image-metadata-outcomes",
    label: "EXIF/GPS extraction",
    select: (p) => p.imageMetadataOutcomes,
    problemKeys: ["imageMetadataOutcomes"],
    entity: "image",
    renderItem: (item) => ({
      title: item.name,
      subtitle:
        item.outcome === "original_missing"
          ? "Original missing in storage"
          : "Extraction kept failing",
      details: [
        <div key="error" className="font-mono text-xs text-muted-foreground">
          {item.error}
        </div>,
      ],
      route: entityDetailLink("image", item.id),
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
      fields: facts(
        fact(
          "Imported",
          `${cookbook.recipeCount} of ${cookbook.sourceRecipeCount}`,
        ),
        fact("Missing", String(cookbook.missingRecipeCount), "warning"),
      ),
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
      return {
        title: meal.name ?? mealDay(meal),
        fields: facts(
          meal.name && fact("Day", mealDay(meal)),
          fact("Unpriced recipes", String(meal.recipeCount), "warning"),
        ),
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
    icon: LinkBreakIcon,
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
    icon: NetworkIcon,
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
      fields: [
        {
          label: "Cycle",
          // Codes, not chips: each chip would resolve its name with a request.
          value: (
            <span className="inline-flex flex-wrap items-baseline gap-x-1 font-mono">
              {cycle.path.map((code, index) => (
                // A cycle repeats its first code at the end, so the path up to
                // this step is the unique key.
                <span
                  key={cycle.path.slice(0, index + 1).join(">")}
                  className="inline-flex gap-x-1"
                >
                  {index > 0 && <span aria-hidden>→</span>}
                  <Link
                    {...entityDetailLink(cycle.entity, code)}
                    className="underline-offset-2 hover:underline"
                  >
                    {code}
                  </Link>
                </span>
              ))}
            </span>
          ),
          title: cycle.path.join(" → "),
        },
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
    icon: WarningIcon,
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
    // No meter: proposals come from an external provider and are advisory, so
    // the section is a coverage list that stays out of the defect badge.
    coverage: { keys: ["productsWithBetterUpcData"] },
    icon: DownloadIcon,
    renderItem: (product) => {
      const { proposed } = product;
      return {
        title: product.name,
        // Show the actual value a fresh lookup would write per field — not
        // just which fields are missing — so it's clear what "Apply" changes.
        fields: facts(
          manufacturerFact(product.manufacturer),
          fact("UPC", product.upc),
          proposed.manufacturer != null &&
            fact("New manufacturer", proposed.manufacturer, "positive"),
          proposed.price != null &&
            fact("New price", formatCurrency(proposed.price), "positive"),
        ),
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
        badges: proposed.imageUrl
          ? [
              <Badge key="image" variant="secondary">
                New image
              </Badge>,
            ]
          : [],
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
        fields: facts(
          ...purchaseFacts(purchase),
          purchase.date &&
            fact("Ordered", <DateDisplay start={purchase.date} />),
          purchase.orderId &&
            fact(
              "Order",
              <span className="inline-flex items-center gap-1">
                <span className="font-mono">{purchase.orderId}</span>
                <EntityRefLink
                  variant="order"
                  orderUrl={purchase.orderUrl}
                  orderId={purchase.orderId}
                  vendorName={purchase.vendorName}
                />
              </span>,
            ),
          purchase.vendorId &&
            purchase.vendorName &&
            recordFact("vendor", [
              { id: purchase.vendorId, name: purchase.vendorName },
            ]),
        ),
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
      fields: facts(
        fact("Expenses", formatCurrency(item.expenseTotal)),
        fact(
          "Projected",
          formatCurrency(item.financialReconciliation.projectedTotal),
        ),
        // The gap itself, signed — the finding, rather than making the reader
        // compute it from the two totals beside it.
        fact(
          item.financialReconciliation.delta > 0 ? "Over by" : "Short by",
          formatCurrency(Math.abs(item.financialReconciliation.delta)),
          "warning",
        ),
        fact(
          "Transactions",
          String(item.financialReconciliation.transactionCount),
        ),
        item.vendorId &&
          item.vendorName &&
          recordFact("vendor", [{ id: item.vendorId, name: item.vendorName }]),
      ),
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
      fields: facts(
        fact("Cost", formatCurrency(item.cost)),
        fact(
          item.matchedOn === "stated_total"
            ? "Matches stated total"
            : "Matches expense total",
          `${formatCurrency(
            item.matchedOn === "stated_total" &&
              item.purchaseStatedTotal !== null
              ? item.purchaseStatedTotal
              : item.purchaseExpenseTotal,
          )} (${countLabel(item.purchaseExpenseCount, "line")})`,
          "warning",
        ),
        item.vendorId && item.vendorName
          ? recordFact("vendor", [{ id: item.vendorId, name: item.vendorName }])
          : fact("Vendor", item.vendorName ?? "Deleted"),
        // Labeled but deliberately NOT a link: the expense is the actionable
        // row and the purchase is only context, so every route out of this
        // card points at the expense (see the section note above).
        fact("Purchase", item.purchaseId),
        // Name both days. "3 days apart" alone is a claim the reader can't
        // check without opening both records — exactly the work the card is
        // meant to save.
        fact(
          "Expense date",
          item.expenseDate ? formatDateSpan(item.expenseDate, null) : "Unknown",
        ),
        fact(
          "Purchase date",
          item.purchaseDate
            ? formatDateSpan(item.purchaseDate, null)
            : "Unknown",
        ),
        item.dayDelta > 0 && fact("Apart", countLabel(item.dayDelta, "day")),
        item.alternateMatchCount > 0 &&
          fact("Weaker matches", String(item.alternateMatchCount)),
      ),
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
      // so it leads, and the facts say what is wrong with it.
      title: item.externalId,
      fields: facts(
        fact("Source", item.source),
        shortcodeFact(
          "Claimed by",
          "financialTransaction",
          item.transactionIds,
        ),
      ),
      inlineFix: {
        label: "Choose keeper",
        render: (close) => (
          <DuplicateTransactionRefFix variant={item} close={close} />
        ),
      },
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
      fields: facts(
        fact("Source", item.source),
        shortcodeFact("Claimed by", "financialAccount", item.accountIds),
      ),
      inlineFix: {
        label: "Choose keeper",
        render: (close) => (
          <DuplicateAccountAliasFix variant={item} close={close} />
        ),
      },
    }),
  }),
  section({
    id: "product-identifiers-outside-issuer",
    label: "Identifiers outside the issuer",
    select: (p) => p.productIdentifiersOutsideIssuer,
    problemKeys: ["productIdentifiersOutsideIssuer"],
    entity: "vendor",
    renderItem: (item) => ({
      key: `${item.vendorId}:${item.source}`,
      title: `${item.vendorName}: ${item.source}`,
      fields: facts(
        fact("Issuer", item.issuer ?? "None registered"),
        fact("Identifiers", String(item.identifierCount)),
        fact("Kinds", item.kinds.join(", ")),
      ),
      route: entityDetailLink("vendor", item.vendorId),
      editLabel: "Open vendor",
    }),
  }),
  section({
    id: "provisional-financial-accounts",
    label: "Provisional accounts",
    select: (p) => p.provisionalFinancialAccounts,
    problemKeys: ["provisionalFinancialAccounts"],
    // No meter: receipts keep minting provisional accounts, so there is no
    // denominator this is a fraction of.
    coverage: { keys: ["provisionalFinancialAccounts"] },
    entity: "financialAccount",
    renderItem: (item) => ({
      title: item.name,
      fields: facts(
        fact("Transactions", String(item.transactionCount)),
        fact("Alias or statement ref", "None", "warning"),
      ),
      route: entityDetailLink("financialAccount", item.id),
      editLabel: "Link account",
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
      fields: facts(
        fact("Kind", item.kind),
        fact("Amount", formatCurrency(item.amount)),
        fact(
          "Allocated",
          `${formatCurrency(item.allocatedTotal)} (${countLabel(item.allocationCount, "allocation")})`,
          "warning",
        ),
        item.postedDate &&
          fact("Posted", formatDateSpan(item.postedDate, null)),
        item.purchaseIds.length > 0 &&
          shortcodeFact("Settles", "purchase", item.purchaseIds),
      ),
      details: [
        // The reasons in words. The raw enum slugs (`sum-mismatch`,
        // `kind-sign-violation`) were reaching the page verbatim.
        <div key="reasons" className="text-sm text-destructive">
          {item.reasons
            .map((reason) => ALLOCATION_DEFECT_LABEL[reason] ?? reason)
            .join("; ")}
        </div>,
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
      // type name plus a column name.
      title: item.id,
      fields: facts(
        fact(humanize(item.field), "No longer parses", "destructive"),
      ),
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
    label: "Statement import coverage",
    select: (p) => p.incompleteStatementImports,
    problemKeys: ["incompleteStatementImports"],
    entity: "financialAccount",
    renderItem: (item) => ({
      key: item.fingerprint,
      title: item.label,
      fields: facts(
        fact("Source", item.source),
        fact("Attached", `${item.rowCountStored} of ${item.rowCountDeclared}`),
        fact(
          "To check",
          String(item.rowCountDeclared - item.rowCountStored),
          "warning",
        ),
      ),
      details: [
        <p key="overlap" className="text-sm text-muted-foreground">
          Rows already present in another import are not attached here. Reopen
          the source CSV to check coverage and resume any interrupted import.
        </p>,
      ],
      route: { href: "/statement-rows/import" },
      editLabel: "Open statement importer",
    }),
  }),
];

export const PROBLEM_SECTIONS: SectionsClaimingEveryCoverageKey<
  typeof DECLARED_SECTIONS
> = DECLARED_SECTIONS;
