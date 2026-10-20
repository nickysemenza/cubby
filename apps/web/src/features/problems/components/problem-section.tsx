import type { Entity } from "@cubby/schemas/entity";
import type { BrowserRoutedEntity } from "@cubby/schemas/entity-manifest";
import { parseShortcode } from "@cubby/shared";
import { countLabel } from "@cubby/shared/pluralize";
import { ArrowSquareOutIcon } from "@phosphor-icons/react/dist/csr/ArrowSquareOut";
import { WarningIcon } from "@phosphor-icons/react/dist/csr/Warning";
import { WrenchIcon } from "@phosphor-icons/react/dist/csr/Wrench";
import { XIcon } from "@phosphor-icons/react/dist/csr/X";
import type { Icon } from "@phosphor-icons/react/lib";
import { Link } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";

import { EntityIdentityMark } from "~/entity/components/entity-identity-mark";
import { EntityRefLink } from "~/entity/components/entity-ref-link";
import {
  type EntityDetailParams,
  type EntityDetailRoute,
  entityDetailLink,
  isBrowserRoutedEntity,
} from "~/entity/entities";
import { useEntityDisplayImage } from "~/entity/entity-media/entity-display-images";
import {
  hoverPreviewEntities,
  type HoverPreviewEntity,
} from "~/entity/preview/preview-entities";
import { formatCount } from "~/lib/number-format";
import { cn } from "~/lib/utils";
import { CopyableShortcode } from "~/ui/common/copyable-shortcode";
import type { Fact } from "~/ui/common/facts";
import {
  RecordDot,
  RecordFold,
  RecordGroup,
  RecordList,
  RecordMore,
  recordColumnsOf,
  RecordRow,
  type RecordTone,
} from "~/ui/common/record-list";
import { Stack } from "~/ui/layout";
import { Button } from "~/ui/primitives/button";
import { Progress } from "~/ui/primitives/progress";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "~/ui/primitives/tooltip";

import { useProblemImageRefs } from "./problem-images";
import { useRecipeUsage } from "./recipe-usage-context";

// Cap each group's initial render so one noisy detector (e.g. 50+ unit-coverage
// items after an import) can't become an unscrollable wall. A "+N more" row
// reveals the rest in place.
const INITIAL_VISIBLE = 12;

// Type-safe route patterns for entity detail pages: either a router-typed
// `to`+`params` pair, or a fully-resolved href for rows a detector has already
// turned into a shortcode-bearing path server-side (e.g. the household-tracker
// rows, whose `href` is built from `row.id` in project/attention.ts).
type RoutePattern =
  | { to: EntityDetailRoute; params: EntityDetailParams }
  | { href: string };

// Pull the entity id back out of a RoutePattern — the default card key and the
// recipe-usage lookup both need it. Every shortcode-bearing detail route is
// keyed `$shortcode` uniformly now (the cookbook `$cookbookId` special case
// died with the uuid routes), so the structured branch is a single field read.
const routeEntityId = (route: RoutePattern): string =>
  "href" in route ? route.href : route.params.shortcode;

/**
 * Noun for the "open the full ___" tooltip.
 *
 * Keyed by the leading path segment rather than the router pattern, so an
 * `{ href }` card (every household-tracker row builds its path server-side)
 * resolves the same noun as a `{ to, params }` one. The old pattern-keyed map
 * missed href routes entirely and had no entry for expenses, ingredients, meals
 * or cookbooks, so a large share of the page read "open the full record page".
 */
const ROUTE_NOUN = new Map([
  ["products", "product"],
  ["recipes", "recipe"],
  ["inventory", "inventory entry"],
  ["locations", "location"],
  ["purchases", "purchase"],
  ["vendors", "vendor"],
  ["expenses", "expense"],
  ["ingredients", "ingredient"],
  ["projects", "project"],
  ["tasks", "task"],
  ["meals", "meal"],
  ["cookbooks", "cookbook"],
  ["financial", "financial record"],
  ["emails", "email"],
  ["runs", "run"],
]);

/** First path segment of either route shape, e.g. `/expenses/EXP-1` → `expenses`. */
const routeNoun = (route: RoutePattern): string => {
  const path = "href" in route ? route.href : route.to;
  return ROUTE_NOUN.get(path.split("/").filter(Boolean)[0] ?? "") ?? "record";
};

// Icon can be either a Icon component or an entity key
export type IconProp =
  | { icon: Icon; entity?: never }
  | { entity: Entity; icon?: never };

/** What a section's `renderItem` returns for a single row. */
export type RenderedProblemItem = {
  /**
   * Stable React key. Defaults to `title`-`route.params.id`, which collides
   * when two rows share both (e.g. the same ingredient name twice in one
   * recipe) — set this to a row-unique id in that case. Also required when
   * `route` is absent, since the fallback has no id to key off of.
   */
  key?: string;
  title: string;
  /**
   * Labelled facts; a section aligns its rows' facts into columns by label.
   * A record another row names (a location, a vendor) is a fact whose value
   * is an `EntityRefLink` chip.
   */
  fields?: Fact[];
  /**
   * The copyable code beside the subtitle. Defaults to the code `route` points
   * at; set `null` when the route opens a sample rather than the card's own
   * subject (a manufacturer spelling links one product that uses it).
   */
  shortcode?: string | null;
  /** Status pills beside the title (a code, a "New image" stamp). */
  badges?: ReactNode[];
  details?: ReactNode[];
  /**
   * Absent for a row whose target no longer exists — an orphaned-embedding
   * row points at an entity that was already deleted, so there is nothing to
   * link to. The card renders unlinked (no "Open" button) rather than a link
   * that 404s.
   */
  route?: RoutePattern;
  /**
   * Label for the navigation button. Defaults to `Open {noun}` derived from
   * `route`, which is also what the button's tooltip says — so the two cannot
   * disagree, and a new section gets a correct label for free.
   *
   * Only set this to override the noun. It used to default to "Edit", which was
   * wrong twice over: the button navigates rather than edits, and on the cards
   * that carry an inline Delete or Merge the pair read as "Edit / Delete".
   */
  editLabel?: string;
  customActions?: ReactNode;
  imageSlot?: ReactNode;
  /**
   * Severity cue, rendered as the row's leading mark. Absent uses the section
   * kind's mark.
   */
  tone?: ProblemTone;
  /**
   * Opt-in inline quick-fix. When set, the row grows a toggle button that
   * expands `render(close)` beneath it — resolving the problem without leaving
   * the page. The navigation link stays as an escape hatch. The form owns its
   * own mutation hook (mounted only while open), so `renderItem` stays a pure
   * data function with no hooks. `destructive` tints the toggle; the form
   * still confirms.
   */
  inlineFix?: {
    label: string;
    destructive?: boolean;
    render: (close: () => void) => ReactNode;
  };
};

/** How urgently a row wants attention. Mirrors the attention rules' severity. */
type ProblemTone = "critical" | "warning" | "info";

const TONE_DOT = {
  critical: { tone: "destructive", label: "Critical" },
  warning: { tone: "warning", label: "Warning" },
  info: { tone: "muted", label: "Info" },
} as const satisfies Record<ProblemTone, { tone: RecordTone; label: string }>;

/**
 * Who resolves a section's rows, which sets each row's default mark: a decision
 * is the defect red, a Fix-button row and a coverage row stay quiet.
 */
export type ProblemSectionKind = "needs-you" | "auto-fix" | "coverage";

const KIND_DOT = {
  "needs-you": { tone: "destructive", label: "Needs a decision" },
  "auto-fix": { tone: "muted", label: "Fixes automatically" },
  coverage: { tone: "muted", label: "Not done yet" },
} as const satisfies Record<
  ProblemSectionKind,
  { tone: RecordTone; label: string }
>;

/** A coverage section's denominator — the "M" in "N of M photographed". */
type ProblemSectionMeter = {
  /** Population the remaining items are a fraction of. */
  total: number;
  /** Past-participle for what's been done, e.g. "photographed", "counted". */
  doneLabel: string;
};

/**
 * Present ⇒ this section is backlog, not defects: the rows are things not yet
 * done rather than things that are wrong. See `PROBLEM_CLASS` in
 * @cubby/schemas/problems for which sections are which.
 *
 * Coverage-ness is carried HERE rather than inferred from `meter`, because the
 * two genuinely come apart: `unvalued-buckets` is coverage with no meter (a misc
 * bucket isn't a fraction of anything), and every coverage section is briefly
 * meter-less while its denominators load. Keying the styling off `meter` made
 * both of those render as red defects underneath the "progress, not problems"
 * heading.
 */
export type ProblemSectionCoverage = { meter?: ProblemSectionMeter };

/** What a section derives from its canonical Problem queries. */
export type ProblemSectionContext = {
  /** The read-only "How it works" disclosure. */
  assembly: ReactNode | undefined;
  /** The exact entity list holding every row, when the section has one. */
  listHref: string | undefined;
  /** A stale or unavailable input behind the section's rows. */
  warning: string | undefined;
};

type ProblemSectionProps<T> = {
  items: T[];
  /**
   * How many rows the section really covers, when `items` is only a sample of
   * them. Defaults to `items.length`, which is correct for every section that
   * returns its whole population.
   *
   * Load-bearing for sampled sections: their rows come from page one of a
   * list, so every count here — the meter, the "N of M · K remaining" line,
   * the "+N more" row — would otherwise describe the page.
   */
  count?: number;
  emptyMessage: string;
  renderItem: (item: T) => RenderedProblemItem;
  groupBy?: (items: T[]) => { [key: string]: T[] };
  /** Read-only "How it works" explanation of the canonical Problem query. */
  assembly?: ReactNode;
  /** The exact list holding every row, for the closing "+N more". */
  listHref?: string;
  /** A stale or unavailable input behind this section's rows. */
  warning?: string;
  coverage?: ProblemSectionCoverage;
  kind?: ProblemSectionKind;
  /** Rows shown per group before "+N more"; auto-fix sections preview a few. */
  visible?: number;
};

/**
 * One Problems section's body: an optional warning and coverage meter, its rows
 * as a records ledger, and the "How it works" disclosure. The heading, count
 * and section action belong to the page's `IndexedSections` entry.
 */
export function ProblemSection<T>({
  items,
  emptyMessage,
  renderItem,
  groupBy,
  assembly,
  listHref,
  warning,
  coverage,
  count,
  kind = coverage ? "coverage" : "needs-you",
  visible = INITIAL_VISIBLE,
}: ProblemSectionProps<T>) {
  const meter = coverage?.meter;
  // Every COUNT below is about the population; `items` is only what we render.
  const total = count ?? items.length;
  const groups = groupBy ? groupBy(items) : { "": items };
  // `renderItem` is pure, so render once: the columns and the image batch
  // both read every row before any group renders.
  const rendered = new Map(items.map((item) => [item, renderItem(item)]));
  const renderedItems = [...rendered.values()];
  const columns = recordColumnsOf(
    renderedItems.map((item) => ({ facts: item.fields })),
  );
  useProblemImageRefs(
    renderedItems.flatMap((item) => {
      const ref = rowRef(item);
      return ref && !item.imageSlot
        ? [{ entityKind: ref.entity, entityId: ref.id }]
        : [];
    }),
  );
  const isGrouped =
    Object.keys(groups).length > 1 && Object.keys(groups)[0] !== "";
  const unloaded = total - items.length;

  return (
    <Stack gap="sm">
      {warning && (
        <p className="flex items-center gap-1.5 text-xs text-warning-ink">
          <WarningIcon aria-hidden className="size-3.5 shrink-0" />
          {warning}
        </p>
      )}
      {meter && (
        <Stack gap="xs">
          <Progress value={meter.total - total} max={meter.total} />
          <span className="text-xs font-medium text-slate">
            {formatCount(meter.total - total)} of {formatCount(meter.total)}{" "}
            {meter.doneLabel}
            {" · "}
            {formatCount(total)} remaining
          </span>
        </Stack>
      )}
      {items.length === 0 ? (
        <p className="text-xs/5 text-muted-foreground">{emptyMessage}</p>
      ) : (
        <RecordList columns={columns}>
          {Object.entries(groups).map(([groupName, groupItems]) => (
            <ProblemGroup
              key={groupName}
              groupName={isGrouped ? groupName : ""}
              items={groupItems}
              renderItem={(item) => rendered.get(item) ?? renderItem(item)}
              kind={kind}
              visible={visible}
              // The list link covers every row, loaded or not, so it stands in
              // for a lone group's own reveal.
              listHref={isGrouped ? undefined : listHref}
              unloaded={isGrouped ? 0 : unloaded}
            />
          ))}
          {isGrouped && unloaded > 0 && (
            <SampleTail listHref={listHref} unloaded={unloaded} total={total} />
          )}
        </RecordList>
      )}
      {assembly}
    </Stack>
  );
}

/** Close a sampled list: open the exact list, or say how much isn't shown. */
function SampleTail({
  listHref,
  unloaded,
  total,
}: {
  listHref: string | undefined;
  unloaded: number;
  total: number;
}) {
  return listHref ? (
    <RecordMore label={`+${formatCount(unloaded)} more`} href={listHref} />
  ) : (
    <RecordFold>
      +{formatCount(unloaded)} more not listed here · {formatCount(total)} in
      all
    </RecordFold>
  );
}

/**
 * One group within a section — owns its own reveal so a single noisy group
 * can't dominate the page, and each group expands independently.
 */
function ProblemGroup<T>({
  groupName,
  items,
  renderItem,
  kind,
  visible,
  listHref,
  unloaded,
}: {
  groupName: string;
  items: T[];
  renderItem: (item: T) => RenderedProblemItem;
  kind: ProblemSectionKind;
  visible: number;
  listHref: string | undefined;
  unloaded: number;
}) {
  const [showAll, setShowAll] = useState(false);
  const hidden = showAll ? 0 : Math.max(items.length - visible, 0);
  const shown = hidden ? items.slice(0, visible) : items;
  const rows = shown.map((item) => {
    const rendered = renderItem(item);
    return (
      <ProblemRow
        key={
          rendered.key ??
          (rendered.route
            ? `${rendered.title}-${routeEntityId(rendered.route)}`
            : rendered.title)
        }
        rendered={rendered}
        kind={kind}
      />
    );
  });
  const more =
    listHref && hidden + unloaded > 0 ? (
      <RecordMore
        label={`+${formatCount(hidden + unloaded)} more`}
        href={listHref}
      />
    ) : hidden > 0 ? (
      <RecordMore
        label={`+${formatCount(hidden)} more`}
        onClick={() => setShowAll(true)}
      />
    ) : unloaded > 0 ? (
      <SampleTail
        listHref={undefined}
        unloaded={unloaded}
        total={items.length + unloaded}
      />
    ) : null;

  return groupName ? (
    <RecordGroup label={groupName} count={items.length} more={more}>
      {rows}
    </RecordGroup>
  ) : (
    <>
      {rows}
      {more}
    </>
  );
}

/**
 * The shortcode a row names, read off its route: every detail route is keyed
 * by the record's shortcode, and an `{ href }` route ends in one. A path whose
 * last segment isn't a code (a filtered list, a workbench) yields none.
 */
const routeShortcode = (route: RoutePattern): string | null =>
  parseShortcode(
    "href" in route
      ? (route.href.split("?")[0]?.split("/").filter(Boolean).at(-1) ?? "")
      : route.params.shortcode,
  )?.shortcode ?? null;

type RowRef = { entity: BrowserRoutedEntity; id: string };

/**
 * The record a row is about, when its title names it: the route's shortcode,
 * unless the row says its route opens a sample (`shortcode: null`) or the
 * route ends in no code (a filtered list, a workbench).
 */
const rowRef = (rendered: RenderedProblemItem): RowRef | null => {
  if (rendered.shortcode === null || !rendered.route) return null;
  const parsed = parseShortcode(
    rendered.shortcode ?? routeShortcode(rendered.route) ?? "",
  );
  if (!parsed || !isBrowserRoutedEntity(parsed.type)) return null;
  return { entity: parsed.type, id: parsed.shortcode };
};

const isHoverPreviewEntity = (
  entity: BrowserRoutedEntity,
): entity is HoverPreviewEntity =>
  hoverPreviewEntities.some((candidate) => candidate === entity);

/** The row's own record as a link: hover preview where the entity has one. */
function RowTitle({ refTo, title }: { refTo: RowRef; title: string }) {
  const image = useEntityDisplayImage({
    entityKind: refTo.entity,
    entityId: refTo.id,
  });
  const text = <span className="min-w-0 text-sm/5 break-words">{title}</span>;
  const entity = refTo.entity;
  return isHoverPreviewEntity(entity) ? (
    <EntityRefLink
      variant="preview"
      entity={entity}
      id={refTo.id}
      displayImage={image}
      showIdentityMark={false}
      className="min-w-0 underline-offset-2 hover:underline"
    >
      {text}
    </EntityRefLink>
  ) : (
    <Link
      {...entityDetailLink(entity, refTo.id)}
      className="min-w-0 underline-offset-2 hover:underline"
    >
      {text}
    </Link>
  );
}

/** The row's leading identity: its record's cover, or the entity's mark. */
function RowMark({ refTo }: { refTo: RowRef }) {
  const image = useEntityDisplayImage({
    entityKind: refTo.entity,
    entityId: refTo.id,
  });
  return (
    <EntityIdentityMark entity={refTo.entity} displayImage={image} size="row" />
  );
}

/**
 * One problem as a record row: its record's image, the record's name as a
 * link (wrapping, never clipped), the copyable code, labelled facts in the
 * section's columns, and quiet actions in the shared right-hand column. Holds
 * its own expand state so opening an inline fix on one row doesn't re-render
 * or collapse the others.
 */
function ProblemRow({
  rendered,
  kind,
}: {
  rendered: RenderedProblemItem;
  kind: ProblemSectionKind;
}) {
  const [open, setOpen] = useState(false);
  const {
    title,
    fields,
    badges = [],
    details = [],
    route,
    editLabel,
    customActions,
    imageSlot,
    inlineFix,
    tone,
  } = rendered;
  const shortcode =
    rendered.shortcode === undefined
      ? route
        ? routeShortcode(route)
        : null
      : rendered.shortcode;
  const refTo = rowRef(rendered);
  // A linked title is the way in; the icon button only remains for rows whose
  // title names something other than the route's record.
  const openLabel =
    route && !refTo ? (editLabel ?? `Open ${routeNoun(route)}`) : "";
  const mark = tone ? TONE_DOT[tone] : KIND_DOT[kind];

  // How many recipes use this product (via its ingredient) — a "how much does
  // fixing this matter" signal. Only set for ingredient-linked products.
  const recipeUsage = useRecipeUsage();
  const recipeCount =
    refTo?.entity === "product" ? recipeUsage[refTo.id] : undefined;

  const hasDetail = details.length > 0 || (inlineFix && open);

  return (
    <RecordRow
      leading={
        imageSlot ? (
          <div className="size-6 shrink-0 overflow-hidden bg-muted">
            {imageSlot}
          </div>
        ) : refTo && !tone ? (
          // An explicit tone is per-row signal and keeps its dot; the
          // section-wide default is already the heading's.
          <RowMark refTo={refTo} />
        ) : (
          <RecordDot tone={mark.tone} label={mark.label} />
        )
      }
      primary={
        <span className="inline-flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5">
          {refTo ? (
            <RowTitle refTo={refTo} title={title} />
          ) : (
            <span className="min-w-0 text-sm/5 break-words">{title}</span>
          )}
          {badges}
        </span>
      }
      secondary={
        shortcode ? (
          <CopyableShortcode
            code={shortcode}
            className="shrink-0 pointer-coarse:min-h-11"
          />
        ) : undefined
      }
      facts={fields}
      clip={false}
      trailing={
        recipeCount === undefined
          ? undefined
          : countLabel(recipeCount, "recipe")
      }
      actions={
        inlineFix || openLabel || customActions ? (
          // One line: a wrapped command column steals height from every row.
          <div className="flex items-center justify-end gap-1 whitespace-nowrap">
            {inlineFix && (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="sm"
                      className={cn(
                        inlineFix.destructive && !open && "text-destructive",
                      )}
                      onClick={() => setOpen((o) => !o)}
                    />
                  }
                >
                  {open ? <XIcon /> : <WrenchIcon />}
                  {open ? "Cancel" : inlineFix.label}
                </TooltipTrigger>
                <TooltipContent>Quick fix — just this item</TooltipContent>
              </Tooltip>
            )}
            {route && openLabel && (
              // Icon-only: the label lives in the accessible name and tooltip.
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={openLabel}
                      render={
                        "href" in route ? (
                          <Link to={route.href} />
                        ) : (
                          <Link to={route.to} params={route.params} />
                        )
                      }
                      nativeButton={false}
                    />
                  }
                >
                  <ArrowSquareOutIcon />
                </TooltipTrigger>
                <TooltipContent>{openLabel}</TooltipContent>
              </Tooltip>
            )}
            {customActions}
          </div>
        ) : undefined
      }
      detail={
        hasDetail ? (
          <Stack gap="xs" className="text-xs">
            {details.length > 0 && <Stack gap="xs">{details}</Stack>}
            {inlineFix && open && (
              <div className="border-t pt-2">
                {inlineFix.render(() => setOpen(false))}
              </div>
            )}
          </Stack>
        ) : undefined
      }
    />
  );
}
