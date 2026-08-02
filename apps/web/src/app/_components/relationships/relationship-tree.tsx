import type { Entity } from "@cubby/schemas/entity";
import { ChevronRight, Network, RotateCcw } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { Button } from "~/components/ui/button";
import type { EntityDetailRoute } from "~/entities/entities";
import { entities, entityDetailParams } from "~/entities/entities";
import { cn } from "~/lib/utils";
import { TableLink } from "../table/TableLink";

/** The maximum number of entity rows an Expand all request may reveal. */
const RELATIONSHIP_EXPAND_LIMIT = 500;

/** A compact, routeable record returned by the relationship explorer API. */
export interface RelationshipEntity {
  entity: Entity;
  /** Public shortcode for normal entities; image keeps its UUID route id. */
  id: string;
  label: string;
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

export interface RelationshipPreset {
  key: string;
  label: string;
  groups: readonly RelationshipGroup[];
}

interface RelationshipChildrenPage {
  items: readonly RelationshipEntity[];
  hasMore: boolean;
}

export interface RelationshipTreeProps {
  /** Presets come from the graph API; the first is the recommended default. */
  presets: readonly RelationshipPreset[];
  /**
   * Optional lazy loader. It deliberately has no tRPC dependency so callers
   * can adopt the component before the graph endpoints are available.
   */
  loadChildren?: (input: {
    presetKey: string;
    relationKey: string;
    parent?: RelationshipEntity;
    offset: number;
  }) => Promise<RelationshipChildrenPage>;
  /** Optional compact start state for detail pages. */
  initialExpandedGroupKeys?: readonly string[];
  className?: string;
}

type LoadedPage = RelationshipChildrenPage & {
  loading?: boolean;
  error?: boolean;
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
  return item.entity === "image"
    ? { id: item.id }
    : entityDetailParams(item.id);
}

function EntityRow({
  item,
  depth,
}: {
  item: RelationshipEntity;
  depth: number;
}) {
  const Icon = entities[item.entity].lucideIcon;
  return (
    <div
      className="flex min-w-0 items-center gap-1 border-[var(--border)] border-t px-2 py-1 text-sm"
      style={{ paddingLeft: `${depth * 1.25 + 0.5}rem` }}
    >
      <Icon className="size-3 shrink-0 text-slate" aria-hidden />
      <TableLink
        to={entities[item.entity].routes.detail as EntityDetailRoute}
        params={routeParams(item)}
        className="min-w-0 truncate"
        variant="muted"
      >
        {item.label}
      </TableLink>
      {item.facts && item.facts.length > 0 && (
        <span className="ml-auto shrink-0 truncate font-mono text-2xs text-slate">
          {item.facts.join(" · ")}
        </span>
      )}
      {item.cycle && (
        <span className="shrink-0 font-mono text-2xs text-slate uppercase tracking-wider">
          See above
        </span>
      )}
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
}: {
  group: RelationshipGroup;
  depth: number;
  expanded: boolean;
  onToggle: () => void;
  page?: LoadedPage;
  onLoadMore: () => void;
  loadChildren?: RelationshipTreeProps["loadChildren"];
}) {
  const visibleItems = page?.items ?? group.items ?? [];
  const hasMore = page?.hasMore ?? group.hasMore ?? false;
  const error = page?.error;
  const loading = page?.loading;
  return (
    <div>
      <button
        type="button"
        className="flex w-full items-center gap-1 border-[var(--border)] border-t px-2 py-1 text-left font-mono text-2xs text-slate uppercase tracking-wider hover:bg-muted"
        style={{ paddingLeft: `${depth * 1.25 + 0.5}rem` }}
        aria-expanded={expanded}
        onClick={onToggle}
      >
        <ChevronRight
          className={cn("size-3 transition-transform", expanded && "rotate-90")}
        />
        <span>{group.label}</span>
        <span className="text-muted-foreground tabular-nums">
          ({group.totalCount})
        </span>
      </button>
      {expanded && (
        <div>
          {visibleItems.map((item) => (
            <EntityRow key={entityKey(item)} item={item} depth={depth + 1} />
          ))}
          {visibleItems.length === 0 && !loading && !error && (
            <p
              className="border-[var(--border)] border-t px-2 py-1 text-muted-foreground text-sm"
              style={{ paddingLeft: `${(depth + 1) * 1.25 + 0.5}rem` }}
            >
              No linked records.
            </p>
          )}
          {loading && (
            <p className="border-[var(--border)] border-t px-2 py-1 text-muted-foreground text-sm">
              Loading…
            </p>
          )}
          {error && (
            <Button
              variant="ghost"
              size="sm"
              className="m-1"
              onClick={onLoadMore}
            >
              <RotateCcw /> Retry
            </Button>
          )}
          {hasMore && !loading && !error && loadChildren && (
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
      (activePreset?.groups[0] ? [activePreset.groups[0].key] : []),
    [activePreset, initialExpandedGroupKeys],
  );
  const [expanded, setExpanded] = useState<Set<string>>(
    () => new Set(initialKeys),
  );
  const [pages, setPages] = useState<Record<string, LoadedPage>>({});
  const [limitMessage, setLimitMessage] = useState<string>();

  const loadPage = useCallback(
    async (group: RelationshipGroup, append: boolean) => {
      if (!activePreset || !loadChildren) return;
      const stateKey = groupStateKey(activePreset.key, group.key);
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
          offset: baseItems.length,
        });
        setPages((current) => ({
          ...current,
          [stateKey]: {
            items: [...baseItems, ...next.items],
            hasMore: next.hasMore,
          },
        }));
      } catch {
        setPages((current) => ({
          ...current,
          [stateKey]: { items: baseItems, hasMore: false, error: true },
        }));
      }
    },
    [activePreset, loadChildren, pages],
  );

  const toggleGroup = useCallback(
    (group: RelationshipGroup) => {
      if (!activePreset) return;
      const stateKey = groupStateKey(activePreset.key, group.key);
      setExpanded((current) => {
        const next = new Set(current);
        if (next.has(stateKey)) next.delete(stateKey);
        else next.add(stateKey);
        return next;
      });
      if (!pages[stateKey] && !group.items && loadChildren)
        void loadPage(group, false);
    },
    [activePreset, loadChildren, loadPage, pages],
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

  return (
    <section className={cn("min-w-0", className)} aria-label="Relationships">
      <div className="flex flex-wrap items-center gap-1 border-[var(--border)] border-b pb-2">
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
      <div className="border-[var(--border)] border-x border-b">
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
            />
          );
        })}
      </div>
      {limitMessage && (
        <p className="mt-2 text-muted-foreground text-sm">{limitMessage}</p>
      )}
    </section>
  );
}

/** A conventional detail-section icon for pages composing the tree manually. */
export const relationshipsSectionIcon = Network;
