import type { Entity } from "@cubby/schemas/entity";
import { relatedViewRegistry } from "@cubby/schemas/related-view";
import { CaretRightIcon } from "@phosphor-icons/react/dist/csr/CaretRight";
import { NetworkIcon } from "@phosphor-icons/react/dist/csr/Network";
import { type ReactNode, useCallback, useMemo, useState } from "react";

import { EntityIdentityMark } from "~/components/entity/entity-identity-mark";
import { ErrorDisplay } from "~/components/feedback/error-display";
import { Button } from "~/components/ui/button";
import {
  browserEntityDefinition,
  entityDetailParams,
  isBrowserRoutedEntity,
} from "~/entities/entities";
import type { EntityDetailRoute } from "~/entities/entities";
import { cn } from "~/lib/utils";

import { TableLink } from "../table/TableLink";

/** The maximum number of entity rows an Expand all request may reveal. */
const RELATIONSHIP_EXPAND_LIMIT = 500;

/** A compact, routeable record returned by the relationship explorer API. */
export interface RelationshipEntity {
  entity: Entity;
  /** Public shortcode. */
  id: string;
  label: string;
  displayImage: { url: string } | null;
  /** Compact typed facts, already formatted by the API when appropriate. */
  facts?: readonly string[];
  /** An ancestor repeat is informative but cannot be expanded again. */
  cycle?: boolean;
}

export interface RelationshipGroup {
  /** Stable graph relation/direction key. */
  key: string;
  label: string;
  totalCount: number;
  /** The first lazy page, if it was delivered with the parent response. */
  items?: readonly RelationshipEntity[];
  /** Whether there are more entries beyond `items`. */
  hasMore?: boolean;
}

interface RelationshipPreset {
  key: string;
  label: string;
  groups: readonly RelationshipGroup[];
}

interface RelationshipChildrenPage {
  items: readonly RelationshipEntity[];
  hasMore: boolean;
  totalCount?: number;
}

export interface RelationshipTreeProps {
  /** Presets come from the graph API; the first is the recommended default. */
  presets: readonly RelationshipPreset[];
  /**
   * Optional lazy loader. It deliberately has no transport dependency so callers
   * can adopt the component before the graph endpoints are available.
   */
  loadChildren?: (input: {
    presetKey: string;
    relationKey: string;
    parent?: RelationshipEntity;
    offset: number;
  }) => Promise<RelationshipChildrenPage>;
  /** Optional compact start state for detail pages. */
  /** Composed `groupStateKey(presetKey, relationKey)` entries, when overridden. */
  initialExpandedGroupKeys?: readonly string[];
  className?: string;
}

type LoadedPage = RelationshipChildrenPage & {
  loading?: boolean;
  error?: unknown;
};

const EMPTY_PRESETS: readonly RelationshipPreset[] = [];

function entityKey(entity: RelationshipEntity) {
  return `${entity.entity}:${entity.id}`;
}

function groupStateKey(
  presetKey: string,
  relationKey: string,
  parent?: RelationshipEntity,
) {
  return `${presetKey}:${parent ? `${entityKey(parent)}:` : "root:"}${relationKey}`;
}

function routeParams(item: RelationshipEntity) {
  return entityDetailParams(item.id);
}

function EntityRow({
  item,
  depth,
  expandable,
  expanded,
  onToggle,
  children,
}: {
  item: RelationshipEntity;
  depth: number;
  expandable: boolean;
  expanded: boolean;
  onToggle: () => void;
  children?: ReactNode;
}) {
  return (
    <div>
      <div
        className={cn(
          "flex min-w-0 items-center gap-1 border-t border-[var(--border)] px-2 py-1 text-sm",
          item.cycle && "text-muted-foreground",
        )}
        style={{ paddingLeft: `${depth * 1.25 + 0.5}rem` }}
      >
        {expandable ? (
          <button
            type="button"
            aria-label={
              expanded ? "Collapse related records" : "Expand related records"
            }
            aria-expanded={expanded}
            onClick={onToggle}
            className="shrink-0 rounded p-1 hover:bg-muted"
          >
            <CaretRightIcon
              className={cn(
                "size-3 transition-transform",
                expanded && "rotate-90",
              )}
            />
          </button>
        ) : (
          <span className="size-4 shrink-0" />
        )}
        <EntityIdentityMark
          entity={item.entity}
          displayImage={item.displayImage}
          size="row"
        />
        {isBrowserRoutedEntity(item.entity) ? (
          <TableLink
            to={
              // SAFETY: `isBrowserRoutedEntity` proves this entity has a detail
              // route; the generated manifest loses that key correlation when
              // indexing through the runtime entity union.
              browserEntityDefinition(item.entity).routes
                .detail as EntityDetailRoute
            }
            params={routeParams(item)}
            className="min-w-0 truncate"
            variant="muted"
          >
            {item.label}
          </TableLink>
        ) : (
          <span className="min-w-0 truncate text-muted-foreground">
            {item.label}
          </span>
        )}
        <span className="shrink-0 font-mono text-2xs text-slate">
          {item.id}
        </span>
        {item.facts && item.facts.length > 0 && (
          <span className="ml-auto shrink-0 truncate font-mono text-2xs text-slate">
            {item.facts.join(" · ")}
          </span>
        )}
        {item.cycle && (
          <span className="shrink-0 font-mono text-2xs tracking-wider text-slate uppercase">
            Reference
          </span>
        )}
      </div>
      {children}
    </div>
  );
}

function GroupRow({
  group,
  depth,
  expanded,
  onToggle,
  page,
  onLoadMore,
  loadChildren,
  renderEntity,
}: {
  group: RelationshipGroup;
  depth: number;
  expanded: boolean;
  onToggle: () => void;
  page?: LoadedPage;
  onLoadMore: () => void;
  loadChildren?: RelationshipTreeProps["loadChildren"];
  renderEntity: (item: RelationshipEntity, depth: number) => ReactNode;
}) {
  const visibleItems = page?.items ?? group.items ?? [];
  const hasMore = page?.hasMore ?? group.hasMore ?? false;
  const error = page?.error;
  const hasError = error !== undefined;
  const loading = page?.loading;
  return (
    <div>
      <button
        type="button"
        className="flex min-h-11 w-full items-center gap-1 border-t border-[var(--border)] px-2 py-1 text-left font-mono text-2xs tracking-wider text-slate uppercase hover:bg-muted md:min-h-0"
        style={{ paddingLeft: `${depth * 1.25 + 0.5}rem` }}
        aria-expanded={expanded}
        onClick={onToggle}
      >
        <CaretRightIcon
          className={cn("size-3 transition-transform", expanded && "rotate-90")}
        />
        <span>{group.label}</span>
        <span className="text-muted-foreground tabular-nums">
          ({group.totalCount})
        </span>
      </button>
      {expanded && (
        <div>
          {visibleItems.map((item) => renderEntity(item, depth + 1))}
          {visibleItems.length === 0 && !loading && !hasError && (
            <p
              className="border-t border-[var(--border)] px-2 py-1 text-sm text-muted-foreground"
              style={{ paddingLeft: `${(depth + 1) * 1.25 + 0.5}rem` }}
            >
              No linked records.
            </p>
          )}
          {loading && (
            <p className="border-t border-[var(--border)] px-2 py-1 text-sm text-muted-foreground">
              Loading…
            </p>
          )}
          {hasError && (
            <ErrorDisplay
              error={error}
              title="these related records"
              className="m-1"
              onRetry={onLoadMore}
            />
          )}
          {hasMore && !loading && !hasError && loadChildren && (
            <Button
              variant="ghost"
              size="sm"
              className="m-1"
              onClick={onLoadMore}
            >
              Load more
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Dense, read-only outline renderer for canonical graph responses.
 *
 * The component owns expansion and branch-local lazy loading, but not fetching
 * itself. That makes it safe to ship ahead of a new relatedData API and lets
 * detail pages pass the API's first-page payload directly.
 */
export function RelationshipTree({
  presets = EMPTY_PRESETS,
  loadChildren,
  initialExpandedGroupKeys,
  className,
}: RelationshipTreeProps) {
  const [activePresetKey, setActivePresetKey] = useState(() => presets[0]?.key);
  const activePreset = useMemo(
    () =>
      presets.find((preset) => preset.key === activePresetKey) ?? presets[0],
    [activePresetKey, presets],
  );
  const initialKeys = useMemo(
    () =>
      initialExpandedGroupKeys ??
      (activePreset?.groups[0]
        ? [groupStateKey(activePreset.key, activePreset.groups[0].key)]
        : []),
    [activePreset, initialExpandedGroupKeys],
  );
  const [expanded, setExpanded] = useState<Set<string>>(
    () => new Set(initialKeys),
  );
  const [pages, setPages] = useState<Record<string, LoadedPage>>({});
  const [nodeGroups, setNodeGroups] = useState<
    Record<string, readonly RelationshipGroup[]>
  >({});
  const [loadingNodes, setLoadingNodes] = useState<Set<string>>(
    () => new Set(),
  );
  const [limitMessage, setLimitMessage] = useState<string>();

  const loadPage = useCallback(
    async (
      group: RelationshipGroup,
      append: boolean,
      parent?: RelationshipEntity,
    ) => {
      if (!activePreset || !loadChildren) return;
      const stateKey = groupStateKey(activePreset.key, group.key, parent);
      const previous = pages[stateKey];
      const baseItems = append ? (previous?.items ?? group.items ?? []) : [];
      setPages((current) => ({
        ...current,
        [stateKey]: { items: baseItems, hasMore: false, loading: true },
      }));
      try {
        const next = await loadChildren({
          presetKey: activePreset.key,
          relationKey: group.key,
          parent,
          offset: baseItems.length,
        });
        setPages((current) => ({
          ...current,
          [stateKey]: {
            items: [...baseItems, ...next.items],
            hasMore: next.hasMore,
          },
        }));
      } catch (err) {
        setPages((current) => ({
          ...current,
          [stateKey]: { items: baseItems, hasMore: false, error: err },
        }));
      }
    },
    [activePreset, loadChildren, pages],
  );

  const toggleGroup = useCallback(
    (group: RelationshipGroup, parent?: RelationshipEntity) => {
      if (!activePreset) return;
      const stateKey = groupStateKey(activePreset.key, group.key, parent);
      setExpanded((current) => {
        const next = new Set(current);
        if (next.has(stateKey)) next.delete(stateKey);
        else next.add(stateKey);
        return next;
      });
      if (!pages[stateKey] && !group.items && loadChildren)
        void loadPage(group, false, parent);
    },
    [activePreset, loadChildren, loadPage, pages],
  );

  const loadNode = useCallback(
    async (item: RelationshipEntity, nodeKey: string) => {
      if (!activePreset || !loadChildren || nodeGroups[nodeKey]) return;
      const views = relatedViewRegistry.filter(
        (view) => view.source === item.entity,
      );
      if (views.length === 0) return;
      setLoadingNodes((current) => new Set(current).add(nodeKey));
      try {
        const pages = await Promise.all(
          views.map(async (view) => {
            const page = await loadChildren({
              presetKey: activePreset.key,
              relationKey: view.key,
              parent: item,
              offset: 0,
            });
            return {
              key: view.key,
              label: view.label,
              totalCount: page.totalCount ?? page.items.length,
              items: page.items,
              hasMore: page.hasMore,
            } satisfies RelationshipGroup;
          }),
        );
        setNodeGroups((current) => ({ ...current, [nodeKey]: pages }));
      } finally {
        setLoadingNodes((current) => {
          const next = new Set(current);
          next.delete(nodeKey);
          return next;
        });
      }
    },
    [activePreset, loadChildren, nodeGroups],
  );

  const selectPreset = useCallback(
    (key: string) => {
      const preset = presets.find((candidate) => candidate.key === key);
      setActivePresetKey(key);
      setExpanded(
        new Set(
          preset?.groups[0] ? [groupStateKey(key, preset.groups[0].key)] : [],
        ),
      );
      setLimitMessage(undefined);
    },
    [presets],
  );

  const expandAll = useCallback(() => {
    if (!activePreset) return;
    let rows = 0;
    const next = new Set<string>();
    for (const group of activePreset.groups) {
      rows +=
        pages[groupStateKey(activePreset.key, group.key)]?.items.length ??
        group.items?.length ??
        0;
      if (rows > RELATIONSHIP_EXPAND_LIMIT) {
        setLimitMessage(
          `Expanded the first ${RELATIONSHIP_EXPAND_LIMIT} linked records. Continue in individual branches.`,
        );
        break;
      }
      next.add(groupStateKey(activePreset.key, group.key));
    }
    setExpanded(next);
  }, [activePreset, pages]);

  if (!activePreset) return null;

  // Reference detection follows the active ancestor path, not mutable render
  // order. Child components may render more than once in React Strict Mode; a
  // shared `seen` Set would therefore relabel every ordinary first-level row
  // as a cycle on its second render. The path also preserves the useful
  // distinction between a genuine cycle and one record appearing truthfully
  // in two sibling relationship branches.
  const renderEntity = (
    item: RelationshipEntity,
    depth: number,
    ancestorKeys: ReadonlySet<string>,
  ): ReactNode => {
    // A bounded outline remains legible and prevents a manually-expanded
    // cyclic graph from becoming an unbounded DOM tree. The detail link still
    // gives the record a full fresh root context.
    const identity = entityKey(item);
    const reference = depth >= 6 || ancestorKeys.has(identity);
    const childAncestors = new Set(ancestorKeys).add(identity);
    const nodeKey = `${activePreset.key}:entity:${entityKey(item)}`;
    const childGroups = nodeGroups[nodeKey];
    const hasChildren =
      !reference &&
      relatedViewRegistry.some((view) => view.source === item.entity);
    const expandedNode = expanded.has(nodeKey);
    return (
      <EntityRow
        key={`${nodeKey}:${depth}`}
        item={reference ? { ...item, cycle: true } : item}
        depth={depth}
        expandable={hasChildren}
        expanded={expandedNode}
        onToggle={() => {
          setExpanded((current) => {
            const next = new Set(current);
            if (next.has(nodeKey)) next.delete(nodeKey);
            else next.add(nodeKey);
            return next;
          });
          if (!expandedNode) void loadNode(item, nodeKey);
        }}
      >
        {expandedNode && loadingNodes.has(nodeKey) && (
          <p
            className="border-t border-[var(--border)] px-2 py-1 text-sm text-muted-foreground"
            style={{ paddingLeft: `${(depth + 1) * 1.25 + 0.5}rem` }}
          >
            Loading connections…
          </p>
        )}
        {expandedNode &&
          childGroups?.map((group) => {
            const stateKey = groupStateKey(activePreset.key, group.key, item);
            return (
              <GroupRow
                key={stateKey}
                group={group}
                depth={depth + 1}
                expanded={expanded.has(stateKey)}
                onToggle={() => toggleGroup(group, item)}
                page={pages[stateKey]}
                onLoadMore={() => void loadPage(group, true, item)}
                loadChildren={loadChildren}
                renderEntity={(child, childDepth) =>
                  renderEntity(child, childDepth, childAncestors)
                }
              />
            );
          })}
      </EntityRow>
    );
  };

  return (
    <section className={cn("min-w-0", className)} aria-label="Relationships">
      <div className="flex flex-wrap items-center gap-1 border-b border-[var(--border)] pb-2">
        {presets.map((preset) => (
          <Button
            key={preset.key}
            variant={preset.key === activePreset.key ? "secondary" : "ghost"}
            size="sm"
            onClick={() => selectPreset(preset.key)}
          >
            {preset.label}
          </Button>
        ))}
        <span className="ml-auto flex gap-1">
          <Button variant="ghost" size="sm" onClick={expandAll}>
            Expand all
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setExpanded(new Set())}
          >
            Collapse all
          </Button>
        </span>
      </div>
      <div className="border-x border-b border-[var(--border)]">
        {activePreset.groups.map((group) => {
          const stateKey = groupStateKey(activePreset.key, group.key);
          return (
            <GroupRow
              key={group.key}
              group={group}
              depth={0}
              expanded={expanded.has(stateKey)}
              onToggle={() => toggleGroup(group)}
              page={pages[stateKey]}
              onLoadMore={() => void loadPage(group, true)}
              loadChildren={loadChildren}
              renderEntity={(item, depth) =>
                renderEntity(item, depth, new Set())
              }
            />
          );
        })}
      </div>
      {limitMessage && (
        <p className="mt-2 text-sm text-muted-foreground">{limitMessage}</p>
      )}
    </section>
  );
}

/** A conventional detail-section icon for pages composing the tree manually. */
export const relationshipsSectionIcon = NetworkIcon;
