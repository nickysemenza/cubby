import type {
  ToolGalleryGroupBy,
  ToolGalleryGroupOut,
  ToolGalleryInventoryEntryOut,
  ToolGalleryItemOut,
} from "@cubby/schemas/project";
import { toolGalleryGroupBy } from "@cubby/schemas/project";
import { keepPreviousData, useInfiniteQuery } from "@tanstack/react-query";
import { LayoutGrid, RotateCw, Search, Wrench } from "lucide-react";
import {
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { z } from "zod";

import {
  GroupedFlow,
  type GroupedFlowGroup,
  groupedFlowSectionId,
  shelfGridClass,
} from "~/app/_components/data-table/shelf";
import { EntityWorkbenchInspector } from "~/app/_components/entity-workbench-inspector";
import {
  type EntityPreviewRendererProps,
  useEntityPreview,
} from "~/app/_components/hooks/useEntityPreview";
import { tryFormatAmount } from "~/app/_components/inventory/format-amount";
import { ErrorDisplay } from "~/components/feedback/error-display";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { FilterableCombobox } from "~/components/ui/combobox";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyIcon,
  EmptyTitle,
} from "~/components/ui/empty";
import { Image } from "~/components/ui/image";
import { Input } from "~/components/ui/input";
import { NativeSelect } from "~/components/ui/native-select";
import { Skeleton } from "~/components/ui/skeleton";
import { Spinner } from "~/components/ui/spinner";
import { useHydrated } from "~/hooks/useHydrated";
import { cn, formatCurrency } from "~/lib/utils";

import { project } from "../projects/project.functions";

const PAGE_SIZE = 60;
const DIRECT_GROUP_JUMP_LIMIT = 10;

export interface ToolGalleryPageOperations {
  gallery: typeof project.toolGallery;
}

const productionOperations: ToolGalleryPageOperations = {
  gallery: project.toolGallery,
};

const GROUP_OPTIONS: ReadonlyArray<{
  value: ToolGalleryGroupBy;
  label: string;
}> = [
  { value: "location", label: "Location" },
  { value: "manufacturer", label: "Manufacturer" },
  { value: "trade", label: "Trade" },
];

const GROUP_NOUN = {
  location: "location",
  manufacturer: "manufacturer",
  trade: "trade",
} as const satisfies Record<ToolGalleryGroupBy, string>;

export type ToolGalleryPresentation = "cards" | "compact" | "flow";

export function toolLocationPath(entry: ToolGalleryInventoryEntryOut): string {
  return [...entry.location.ancestors, entry.location]
    .map((part) => part.name)
    .join(" / ");
}

type ToolPlacementSummary = {
  label: string;
  mixed: boolean;
  installed: boolean;
};

export function toolPlacementSummary(
  entries: ToolGalleryInventoryEntryOut[],
): ToolPlacementSummary {
  const installed = entries.some((entry) => entry.placement === "installed");
  if (entries.length === 1) {
    return {
      label: tryFormatAmount(entries[0]!.amount),
      mixed: false,
      installed,
    };
  }
  const units = new Set(entries.map((entry) => entry.amount.unit));
  return {
    label: `${entries.length} placements${units.size > 1 ? " · Mixed amounts" : ""}`,
    mixed: units.size > 1,
    installed,
  };
}

function GallerySkeleton({ compact }: { compact: boolean }) {
  return (
    <div aria-label="Loading tool gallery" className={shelfGridClass(compact)}>
      {Array.from({ length: 12 }, (_, index) => (
        <div key={index} className="border border-[var(--border)] bg-card">
          <Skeleton className="aspect-square w-full rounded-none" />
          <div className="space-y-2 p-2">
            <Skeleton className="h-4 w-4/5" />
            <Skeleton className="h-3 w-3/5" />
            <Skeleton className="h-8 w-full" />
          </div>
        </div>
      ))}
    </div>
  );
}

export function ToolCard({
  item,
  compact = false,
  current,
  describedBy,
  onInspect,
  onHover,
  onHoverEnd,
}: {
  item: ToolGalleryItemOut;
  compact?: boolean;
  current: boolean;
  describedBy?: string;
  onInspect: () => void;
  onHover: () => void;
  onHoverEnd: () => void;
}) {
  const placements = toolPlacementSummary(item.inventoryEntries);
  const maker = item.manufacturer.trim();
  const identity = [maker === "(unspecified)" ? null : maker, item.model]
    .filter(Boolean)
    .join(" · ");
  const shownEntries = item.inventoryEntries.slice(0, 2);

  return (
    <button
      type="button"
      aria-current={current ? "true" : undefined}
      aria-describedby={describedBy}
      onClick={onInspect}
      onMouseEnter={onHover}
      onMouseLeave={onHoverEnd}
      onFocus={onHover}
      onBlur={onHoverEnd}
      className={cn(
        "group flex h-full min-h-0 w-full flex-col overflow-hidden border bg-card text-left transition-colors duration-150 outline-none",
        "border-[var(--border)] hover:border-primary/50 hover:bg-muted/30 focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-primary/25",
        current && "border-primary ring-1 ring-primary/20",
      )}
    >
      <div className="relative aspect-square w-full shrink-0 overflow-hidden bg-muted/20">
        <Image
          src={item.coverImageUrl ?? ""}
          alt={item.productName}
          // 6-column grid: ~270px per card on screens up to 1920px wide. Only an
          // ultra-wide monitor exceeds 320 (the 640-rung ceiling); accept a
          // softer tile there rather than fetching 2048 everywhere.
          displayWidth={compact ? 192 : 320}
          className="absolute inset-0 h-full w-full object-cover transition-transform duration-200 group-hover:scale-[1.015]"
          fallback={
            <div className="flex h-full w-full items-center justify-center bg-[var(--domain-house-surface)] text-[var(--domain-house)]">
              <Wrench className="size-8" aria-hidden />
            </div>
          }
        />
        {item.extraImageCount > 0 ? (
          <Badge className="absolute right-1.5 bottom-1.5 border-black/20 bg-black/65 text-white">
            +{item.extraImageCount}
          </Badge>
        ) : null}
        {placements.installed ? (
          <Badge
            variant="slate"
            className="absolute top-1.5 left-1.5 bg-card/95"
          >
            Installed
          </Badge>
        ) : null}
      </div>

      <div className={cn("flex flex-1 flex-col p-2", !compact && "min-h-36")}>
        <h3
          title={item.productName}
          className={cn(
            "line-clamp-2 min-h-9 font-semibold text-foreground",
            compact ? "text-xs/4.5" : "text-sm/4.5",
          )}
        >
          {item.productName}
        </h3>
        <p
          className="mt-1 min-h-4 truncate text-xs text-muted-foreground"
          title={identity || undefined}
        >
          {identity || "Unspecified maker"}
        </p>

        {compact ? (
          <p className="mt-1 text-2xs text-muted-foreground">
            {item.inventoryEntries.length} placement
            {item.inventoryEntries.length === 1 ? "" : "s"}
          </p>
        ) : (
          <>
            <div className="mt-2 min-h-13 border-t border-[var(--border)] pt-2">
              {shownEntries.map((entry) => (
                <div
                  key={entry.id}
                  className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-2 text-2xs/4"
                >
                  <span
                    className="truncate text-muted-foreground"
                    title={toolLocationPath(entry)}
                  >
                    {toolLocationPath(entry)}
                  </span>
                  <span className="font-mono text-foreground tabular-nums">
                    {tryFormatAmount(entry.amount)}
                  </span>
                </div>
              ))}
              {item.inventoryEntries.length > shownEntries.length ? (
                <p className="text-2xs text-muted-foreground">
                  +{item.inventoryEntries.length - shownEntries.length} more
                </p>
              ) : null}
            </div>

            <div className="mt-auto flex items-end justify-between gap-2 border-t border-[var(--border)] pt-2">
              <div className="min-w-0">
                <p className="font-mono text-2xs text-foreground tabular-nums">
                  {placements.label}
                </p>
                <p className="text-2xs text-muted-foreground">
                  {item.projectUseCount === 0
                    ? "No project uses"
                    : `${item.projectUseCount} project use${item.projectUseCount === 1 ? "" : "s"}`}
                </p>
              </div>
              {item.costPerProjectUse !== null ? (
                <span className="shrink-0 font-mono text-xs font-medium text-primary tabular-nums">
                  {formatCurrency(item.costPerProjectUse)}/use
                </span>
              ) : null}
            </div>
          </>
        )}
      </div>
    </button>
  );
}

export function ToolInspectorSummary({ item }: { item: ToolGalleryItemOut }) {
  return (
    <section
      aria-label="Tool placements and usage"
      className="space-y-3 border-b border-border p-3"
    >
      <div className="space-y-2">
        {item.inventoryEntries.map((entry) => (
          <div
            key={entry.id}
            className="flex items-start justify-between gap-2"
          >
            <span className="min-w-0 text-xs text-muted-foreground">
              {toolLocationPath(entry)}
            </span>
            <span className="shrink-0 font-mono text-xs tabular-nums">
              {tryFormatAmount(entry.amount)}
            </span>
          </div>
        ))}
      </div>
      <div className="flex flex-wrap items-baseline justify-between gap-2 text-xs">
        <span>
          {item.projectUseCount === 0
            ? "No project uses"
            : `${item.projectUseCount} project use${item.projectUseCount === 1 ? "" : "s"}`}
        </span>
        {item.costPerProjectUse !== null ? (
          <span className="font-mono text-primary tabular-nums">
            {formatCurrency(item.costPerProjectUse)}/use
          </span>
        ) : null}
      </div>
    </section>
  );
}

function EmptyGallery({
  query,
  onClear,
}: {
  query: string;
  onClear: () => void;
}) {
  return (
    <Empty className="min-h-72 bg-card">
      <EmptyIcon icon={query ? Search : Wrench} />
      <EmptyHeader>
        <EmptyTitle>
          {query ? "No matching tools" : "No inventoried tools"}
        </EmptyTitle>
        <EmptyDescription>
          {query
            ? `Nothing in the tool inventory matches “${query}”.`
            : "Products categorized as tools appear here once they have a live inventory placement."}
        </EmptyDescription>
      </EmptyHeader>
      {query ? (
        <Button variant="outline" onClick={onClear}>
          Clear search
        </Button>
      ) : null}
    </Empty>
  );
}

function GroupJumpBar({
  groupBy,
  groups,
  activeGroupKey,
  onJump,
  disabled,
}: {
  groupBy: ToolGalleryGroupBy;
  groups: ToolGalleryGroupOut[];
  activeGroupKey?: string;
  onJump: (groupKey: string) => void;
  disabled: boolean;
}) {
  if (groups.length < 2) return null;

  const noun = GROUP_NOUN[groupBy];
  const usesPicker = groups.length > DIRECT_GROUP_JUMP_LIMIT;
  return (
    <nav
      aria-label="Tool gallery sections"
      data-tool-group-jump-bar
      className="sticky top-[var(--app-chrome-top)] z-20 -mx-2 mb-4 border-y border-[var(--border)] bg-background px-2 py-2 md:-mx-6 md:px-6"
    >
      <div className="flex min-w-0 items-center gap-2">
        <span className="shrink-0 eyebrow">Jump to</span>
        {usesPicker ? (
          <div className="min-w-0 flex-1 sm:max-w-sm">
            <FilterableCombobox
              items={groups.map((group) => ({
                value: group.key,
                label: group.label,
                hint: String(group.itemCount),
              }))}
              value={activeGroupKey ?? null}
              onValueChange={(value) => {
                if (value !== null) onJump(value);
              }}
              disabled={disabled}
              placeholder={`Choose a ${noun}`}
              ariaLabel={`Jump to ${noun}`}
              className="bg-card"
            />
          </div>
        ) : (
          <div className="flex min-w-0 flex-1 gap-1 overflow-x-auto py-0.5">
            {groups.map((group) => {
              const active = group.key === activeGroupKey;
              return (
                <Button
                  key={group.key}
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-current={active ? "location" : undefined}
                  onClick={() => onJump(group.key)}
                  disabled={disabled}
                  className={cn(
                    "h-9 shrink-0 rounded-sm border border-transparent px-2 max-sm:h-11",
                    active &&
                      "border-[var(--domain-house)] bg-[var(--domain-house-surface)] text-foreground",
                  )}
                >
                  <span>{group.label}</span>
                  <span className="font-mono text-2xs text-muted-foreground tabular-nums">
                    {group.itemCount}
                  </span>
                </Button>
              );
            })}
          </div>
        )}
      </div>
    </nav>
  );
}

function useToolGroupNavigation({
  groupBy,
  query,
  section,
  groups,
  loadedPageCount,
  layoutKey,
  ready,
  fetchNextPage,
  onSectionChange,
}: {
  groupBy: ToolGalleryGroupBy;
  query: string;
  section?: string;
  groups: ToolGalleryGroupOut[];
  loadedPageCount: number;
  layoutKey: string;
  ready: boolean;
  fetchNextPage: () => Promise<{ isError: boolean }>;
  onSectionChange: (section: string | undefined) => void;
}) {
  const [visibleGroupKey, setVisibleGroupKey] = useState<string>();
  const jumpingRef = useRef<string | undefined>(undefined);
  const handledSectionRef = useRef<string | undefined>(undefined);
  const navigationVersionRef = useRef(0);

  useEffect(() => {
    navigationVersionRef.current += 1;
    setVisibleGroupKey(undefined);
    handledSectionRef.current = undefined;
    jumpingRef.current = undefined;
    return () => {
      navigationVersionRef.current += 1;
    };
  }, [groupBy, query]);

  const scrollToGroup = useCallback(
    async (groupKey: string, behavior: ScrollBehavior, force = false) => {
      const requestKey = `${groupBy}:${query}:${groupKey}`;
      if (!force && handledSectionRef.current === requestKey) return;
      if (jumpingRef.current === requestKey) return;
      const target = groups.find((group) => group.key === groupKey);
      if (!target) {
        if (ready) onSectionChange(undefined);
        return;
      }

      jumpingRef.current = requestKey;
      const navigationVersion = navigationVersionRef.current + 1;
      navigationVersionRef.current = navigationVersion;
      try {
        const targetPage = Math.floor(target.startIndex / PAGE_SIZE);
        for (let page = loadedPageCount; page <= targetPage; page += 1) {
          const result = await fetchNextPage();
          if (result.isError) return;
          if (navigationVersion !== navigationVersionRef.current) return;
        }
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        );
        if (navigationVersion !== navigationVersionRef.current) return;
        const targetSection = document.getElementById(
          groupedFlowSectionId(groupKey),
        );
        if (!targetSection) return;
        targetSection.scrollIntoView({ block: "start", behavior });
        handledSectionRef.current = requestKey;
        setVisibleGroupKey(groupKey);
      } finally {
        if (jumpingRef.current === requestKey) jumpingRef.current = undefined;
      }
    },
    [
      fetchNextPage,
      groupBy,
      groups,
      loadedPageCount,
      onSectionChange,
      query,
      ready,
    ],
  );

  useEffect(() => {
    handledSectionRef.current = undefined;
  }, [layoutKey]);

  useEffect(() => {
    if (section) void scrollToGroup(section, "auto");
  }, [layoutKey, scrollToGroup, section]);

  useEffect(() => {
    if (!ready) return;
    const sections = Array.from(
      document.querySelectorAll<HTMLElement>(
        "[data-tool-gallery-group], [data-grouped-flow-group], [data-grouped-flow-item-group]",
      ),
    );
    if (sections.length === 0) return;

    const groupKeyFor = (node: HTMLElement) =>
      node.dataset.toolGalleryGroup ??
      node.dataset.groupedFlowGroup ??
      node.dataset.groupedFlowItemGroup;
    const updateVisibleGroup = () => {
      const jumpBar = document.querySelector<HTMLElement>(
        "[data-tool-group-jump-bar]",
      );
      const activationTop = jumpBar?.getBoundingClientRect().bottom ?? 104;
      const positioned = sections.map((node) => ({
        node,
        rect: node.getBoundingClientRect(),
      }));
      const eligible = positioned.filter(
        ({ rect }) => rect.top <= activationTop,
      );
      const closestTop = Math.max(
        ...eligible.map(({ rect }) => rect.top),
        Number.NEGATIVE_INFINITY,
      );
      const active =
        eligible
          .filter(({ rect }) => Math.abs(rect.top - closestTop) < 1)
          .sort((a, b) => a.rect.left - b.rect.left)[0]?.node ?? sections[0];
      const groupKey = active ? groupKeyFor(active) : undefined;
      if (groupKey !== undefined) setVisibleGroupKey(groupKey);
    };
    let frame: number | undefined;
    const scheduleUpdate = () => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(updateVisibleGroup);
    };
    const observer = new IntersectionObserver(scheduleUpdate, {
      rootMargin: "-104px 0px -70% 0px",
    });
    sections.forEach((node) => observer.observe(node));
    const resizeObserver = new ResizeObserver(scheduleUpdate);
    for (const parent of new Set(sections.map((node) => node.parentElement))) {
      if (parent) resizeObserver.observe(parent);
    }
    document.addEventListener("scroll", scheduleUpdate, true);
    window.addEventListener("resize", scheduleUpdate);
    scheduleUpdate();
    return () => {
      observer.disconnect();
      resizeObserver.disconnect();
      document.removeEventListener("scroll", scheduleUpdate, true);
      window.removeEventListener("resize", scheduleUpdate);
      if (frame !== undefined) cancelAnimationFrame(frame);
    };
  }, [groups, layoutKey, loadedPageCount, ready]);

  const jumpToGroup = useCallback(
    (groupKey: string) => {
      onSectionChange(groupKey);
      setVisibleGroupKey(groupKey);
      void scrollToGroup(
        groupKey,
        window.matchMedia("(prefers-reduced-motion: reduce)").matches
          ? "auto"
          : "smooth",
        true,
      );
    },
    [onSectionChange, scrollToGroup],
  );

  return {
    activeGroupKey: visibleGroupKey ?? section ?? groups[0]?.key,
    jumpToGroup,
  };
}

function GalleryGroups({
  groups,
  presentation,
  groupMetadata,
  isPlaceholderData,
  error,
  isFetchingNextPage,
  sentinelRef,
  currentProductId,
  onInspect,
  onHover,
  onHoverEnd,
  onRetryMore,
}: {
  groups: Map<string, ToolGalleryItemOut[]>;
  presentation: ToolGalleryPresentation;
  groupMetadata: Map<string, ToolGalleryGroupOut>;
  isPlaceholderData: boolean;
  error: Error | null;
  isFetchingNextPage: boolean;
  sentinelRef: RefObject<HTMLDivElement | null>;
  currentProductId?: string;
  onInspect: (item: ToolGalleryItemOut) => void;
  onHover: (item: ToolGalleryItemOut) => void;
  onHoverEnd: (item: ToolGalleryItemOut) => void;
  onRetryMore: () => void;
}) {
  const compact = presentation !== "cards";
  const renderToolCard = (item: ToolGalleryItemOut, describedBy?: string) => (
    <ToolCard
      key={item.productId}
      item={item}
      compact={compact}
      current={currentProductId === item.productId}
      describedBy={describedBy}
      onInspect={() => onInspect(item)}
      onHover={() => onHover(item)}
      onHoverEnd={() => onHoverEnd(item)}
    />
  );
  const flowGroups: GroupedFlowGroup<ToolGalleryItemOut>[] = [
    ...groupMetadata,
  ].flatMap(([groupKey, metadata]) => {
    const groupItems = groups.get(groupKey);
    return groupItems
      ? [
          {
            id: groupKey,
            label: metadata.label,
            count: metadata.itemCount,
            items: groupItems,
          },
        ]
      : [];
  });

  return (
    <div
      aria-busy={isPlaceholderData}
      className={cn(
        "space-y-6 transition-opacity",
        isPlaceholderData && "pointer-events-none opacity-55",
      )}
    >
      {presentation === "flow" ? (
        <GroupedFlow
          groups={flowGroups}
          getItemKey={(item) => item.productId}
          dividerAccentClassName="bg-[var(--domain-house)]"
          renderItem={(item, _group, headingId) =>
            renderToolCard(item, headingId)
          }
        />
      ) : (
        [...groups].map(([groupKey, groupItems]) => {
          const metadata = groupMetadata.get(groupKey);
          const sectionId = groupedFlowSectionId(groupKey);
          const headingId = `${sectionId}-heading`;
          return (
            <section
              key={groupKey}
              id={sectionId}
              data-tool-gallery-group={groupKey}
              aria-labelledby={headingId}
              className="scroll-mt-28 md:scroll-mt-24"
            >
              <div className="mb-2 flex items-baseline gap-2 border-l-2 border-[var(--domain-house)] pl-2">
                <h2
                  id={headingId}
                  className="text-sm font-semibold text-foreground"
                >
                  {metadata?.label ?? groupItems[0]?.groupLabel}
                </h2>
                <span className="font-mono text-2xs text-muted-foreground tabular-nums">
                  {metadata?.itemCount ?? groupItems.length}
                </span>
              </div>
              <div className={shelfGridClass(compact)}>
                {groupItems.map((item) => renderToolCard(item))}
              </div>
            </section>
          );
        })
      )}

      {error ? (
        <div className="space-y-2">
          <ErrorDisplay error={error} />
          <Button variant="outline" size="sm" onClick={onRetryMore}>
            Retry loading more
          </Button>
        </div>
      ) : null}
      <div
        ref={sentinelRef}
        className="flex h-11 items-center justify-center text-xs text-muted-foreground"
        aria-hidden={!isFetchingNextPage}
      >
        {isFetchingNextPage ? (
          <>
            <Spinner size="sm" />
            <span className="ml-1.5">Loading more tools…</span>
          </>
        ) : null}
      </div>
    </div>
  );
}

export function ToolGalleryPage({
  query,
  presentation = "cards",
  groupBy,
  section,
  onQueryChange,
  onGroupByChange,
  onSectionChange,
  operations = productionOperations,
}: {
  query: string;
  presentation?: ToolGalleryPresentation;
  groupBy: ToolGalleryGroupBy;
  section?: string;
  onQueryChange: (query: string | undefined) => void;
  onGroupByChange: (groupBy: ToolGalleryGroupBy) => void;
  onSectionChange: (section: string | undefined) => void;
  operations?: ToolGalleryPageOperations;
}) {
  const compact = presentation !== "cards";
  const hydrated = useHydrated();
  const [draftQuery, setDraftQuery] = useState(query);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const [inspectedItem, setInspectedItem] = useState<ToolGalleryItemOut | null>(
    null,
  );
  useEffect(() => setDraftQuery(query), [query]);
  useEffect(() => {
    if (draftQuery === query) return;
    const timeout = setTimeout(
      () => onQueryChange(draftQuery.trim() || undefined),
      250,
    );
    return () => clearTimeout(timeout);
  }, [draftQuery, onQueryChange, query]);

  const infiniteOptions = useMemo(
    () =>
      operations.gallery.infiniteQueryOptions(
        {
          search: query || undefined,
          groupBy,
          pagination: { pageIndex: 0, pageSize: PAGE_SIZE },
        },
        {
          initialPageParam: 0,
          pageParamSchema: z.number().int().nonnegative(),
          page: (input, pageIndex) => ({
            ...input,
            pagination: { ...input.pagination, pageIndex },
          }),
          getNextPageParam: (lastPage) => {
            const loaded =
              (lastPage.meta.pageIndex + 1) * lastPage.meta.pageSize;
            return loaded < lastPage.meta.totalCount
              ? lastPage.meta.pageIndex + 1
              : undefined;
          },
        },
      ),
    [groupBy, operations.gallery, query],
  );

  const gallery = useInfiniteQuery({
    ...infiniteOptions,
    placeholderData: keepPreviousData,
  });
  const {
    data,
    error,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    isLoading,
    isPlaceholderData,
    refetch,
  } = gallery;

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || !hasNextPage) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && !isFetchingNextPage) {
          void fetchNextPage({ cancelRefetch: false });
        }
      },
      { rootMargin: "500px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [fetchNextPage, hasNextPage, isFetchingNextPage]);

  const pages = useMemo(() => data?.pages ?? [], [data?.pages]);
  const items = useMemo(() => {
    const seen = new Set<string>();
    return pages
      .flatMap((page) => page.items)
      .filter((item) => {
        if (seen.has(item.productId)) return false;
        seen.add(item.productId);
        return true;
      });
  }, [pages]);
  const currentItem =
    items.find((item) => item.productId === inspectedItem?.productId) ??
    inspectedItem;
  const renderInspector = useCallback(
    ({ preview, onClose }: EntityPreviewRendererProps) => (
      <EntityWorkbenchInspector
        entity="product"
        id={preview.id}
        onClose={onClose}
        overviewSupplement={
          currentItem?.productId === preview.id ? (
            <ToolInspectorSummary item={currentItem} />
          ) : undefined
        }
      />
    ),
    [currentItem],
  );
  const {
    inspectRow,
    onRowHover,
    onRowHoverEnd,
    preview,
    PreviewSheet,
    dockedInspector,
    inspectorToggle,
  } = useEntityPreview("product", {
    responsiveInspector: true,
    renderInspector,
  });
  const groups = useMemo(() => {
    const result = new Map<string, ToolGalleryItemOut[]>();
    for (const item of items) {
      const current = result.get(item.groupKey) ?? [];
      current.push(item);
      result.set(item.groupKey, current);
    }
    return result;
  }, [items]);
  const groupOptions = useMemo(() => pages[0]?.groups ?? [], [pages]);
  const groupMetadata = useMemo(
    () => new Map(groupOptions.map((group) => [group.key, group])),
    [groupOptions],
  );
  const totals = pages[0]?.totals;
  const loadNextPage = useCallback(
    () => fetchNextPage({ cancelRefetch: false }),
    [fetchNextPage],
  );
  const { activeGroupKey, jumpToGroup } = useToolGroupNavigation({
    groupBy,
    query,
    section,
    groups: groupOptions,
    loadedPageCount: pages.length,
    layoutKey: presentation,
    ready: hydrated && data !== undefined && !isPlaceholderData,
    fetchNextPage: loadNextPage,
    onSectionChange,
  });

  let content;
  if (!hydrated || (isLoading && items.length === 0)) {
    content = <GallerySkeleton compact={compact} />;
  } else if (error && items.length === 0) {
    content = (
      <div className="space-y-3">
        <ErrorDisplay error={error} />
        <Button variant="outline" onClick={() => void refetch()}>
          <RotateCw /> Retry
        </Button>
      </div>
    );
  } else if (items.length === 0) {
    content = <EmptyGallery query={query} onClear={() => setDraftQuery("")} />;
  } else {
    content = (
      <GalleryGroups
        groups={groups}
        presentation={presentation}
        groupMetadata={groupMetadata}
        isPlaceholderData={isPlaceholderData}
        error={error}
        isFetchingNextPage={isFetchingNextPage}
        sentinelRef={sentinelRef}
        currentProductId={preview?.id}
        onInspect={(item) => {
          setInspectedItem(item);
          inspectRow({ id: item.productId, original: { id: item.productId } });
        }}
        onHover={(item) =>
          onRowHover({ id: item.productId, original: { id: item.productId } })
        }
        onHoverEnd={(item) =>
          onRowHoverEnd({
            id: item.productId,
            original: { id: item.productId },
          })
        }
        onRetryMore={() => void fetchNextPage()}
      />
    );
  }

  return (
    <>
      <div className="mb-4 flex flex-col gap-2 border-b border-[var(--border)] pb-3 sm:flex-row sm:items-center">
        <label
          htmlFor="tool-gallery-search"
          className="relative min-w-0 flex-1 sm:max-w-md"
        >
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <span className="sr-only">Search inventoried tools</span>
          <Input
            id="tool-gallery-search"
            value={draftQuery}
            onChange={(event) => setDraftQuery(event.target.value)}
            placeholder="Search tools, makers, tags, or locations"
            className="pl-8"
          />
        </label>
        <label htmlFor="tool-gallery-group" className="flex items-center gap-2">
          <span className="shrink-0 eyebrow">Group by</span>
          <NativeSelect
            id="tool-gallery-group"
            value={groupBy}
            onChange={(event) =>
              onGroupByChange(toolGalleryGroupBy.parse(event.target.value))
            }
          >
            {GROUP_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </NativeSelect>
        </label>
        {totals ? (
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground sm:ml-auto">
            <LayoutGrid className="size-3.5 text-[var(--domain-house)]" />
            <span className="font-mono tabular-nums">
              {totals.products} tools · {totals.placements} placements
            </span>
          </div>
        ) : null}
        {inspectorToggle}
      </div>

      <GroupJumpBar
        groupBy={groupBy}
        groups={groupOptions}
        activeGroupKey={activeGroupKey}
        onJump={jumpToGroup}
        disabled={isPlaceholderData}
      />

      <div
        className={cn(
          "min-w-0",
          dockedInspector && "xl:grid xl:grid-cols-[minmax(0,1fr)_25rem]",
        )}
      >
        <div className="min-w-0">{content}</div>
        {dockedInspector ? (
          <aside className="hidden max-h-[calc(100vh-10rem)] overflow-y-auto border border-l-0 border-[var(--border)] bg-card xl:sticky xl:top-20 xl:block xl:self-start">
            {dockedInspector}
          </aside>
        ) : null}
      </div>
      <PreviewSheet />
    </>
  );
}
