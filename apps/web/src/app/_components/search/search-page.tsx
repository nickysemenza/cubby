import type {
  SearchComponentPlacement,
  SearchDestination,
  SearchInventoryPlacement,
  SearchResultGroup,
  SearchType,
} from "@cubby/schemas/search";
import { searchableEntities } from "@cubby/schemas/search";
import { useDebouncedValue } from "@tanstack/react-pacer";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { uniq } from "es-toolkit";
import { ChevronRight, MapPin, Search } from "lucide-react";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";

import { MobileCard } from "~/components/entity/mobile-card";
import { ErrorDisplay } from "~/components/feedback/error-display";
import { MobileCardSkeletonList } from "~/components/feedback/mobile-card-skeleton";
import { Row, Stack } from "~/components/layout";
import { Badge } from "~/components/ui/badge";
import { Input } from "~/components/ui/input";
import { entities } from "~/entities/entities";
import { enumFieldLabel } from "~/entities/enum-field-display";
import { useIsMobile } from "~/hooks/useMobile";
import { search } from "~/lib/search.functions";
import { cn } from "~/lib/utils";

import {
  type EntityPreviewRowData,
  useEntityPreview,
} from "../hooks/useEntityPreview";
import {
  entityTypeMap,
  getSearchMatchText,
  getSearchResultHref,
  getSearchResultRoute,
  SearchResultMedia,
} from "./search-utils";

interface SearchPageProps {
  query?: string;
  type: SearchType;
}

interface SearchPreviewRow {
  original: SearchDestination & EntityPreviewRowData;
}

type SearchPreviewHandler = (row: SearchPreviewRow) => void;

const filterOptions: Array<{ value: SearchType; label: string }> = [
  { value: "all", label: "All" },
  ...searchableEntities.map((entityType) => ({
    value: entityType,
    label: entities[entityTypeMap[entityType]].label,
  })),
];

export function SearchPage({ query = "", type }: SearchPageProps) {
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const { onRowClick, onRowHover, onRowHoverEnd, PreviewSheet } =
    useEntityPreview();
  const [draft, setDraft] = useState(query);
  const relatedHeadingId = useId();
  const initialQuery = useRef(query);
  const didAttachInput = useRef(false);
  const inputRef = useCallback((node: HTMLInputElement | null) => {
    if (!node || didAttachInput.current) return;
    didAttachInput.current = true;
    // Focus only the first attachment of a fresh search surface. The router
    // can reattach this node when returning from detail without remounting the
    // component, and that return must not reopen the keyboard.
    if (initialQuery.current.trim().length === 0) node.focus();
  }, []);
  const [debouncedDraft] = useDebouncedValue(draft, { wait: 150 });
  const [relatedDraft] = useDebouncedValue(draft, { wait: 450 });
  const entityTypes = type === "all" ? undefined : [type];
  const primaryShouldSearch = debouncedDraft.trim().length > 0;
  const relatedShouldSearch =
    relatedDraft.trim().length > 0 && relatedDraft === draft;

  useEffect(() => setDraft(query), [query]);
  useEffect(() => {
    if (debouncedDraft === query) return;
    navigate({
      to: "/search",
      search: {
        q: debouncedDraft || undefined,
        type: type === "all" ? undefined : type,
      },
      replace: true,
    });
  }, [debouncedDraft, navigate, query, type]);

  const primary = useQuery({
    ...search.grouped.queryOptions({
      // Disabled queries still construct and validate their options.
      query: primaryShouldSearch ? debouncedDraft : "inactive-search",
      entityTypes,
      limit: 50,
    }),
    enabled: primaryShouldSearch,
    placeholderData: keepPreviousData,
  });
  const related = useQuery({
    ...search.relatedGrouped.queryOptions({
      query: relatedShouldSearch ? relatedDraft : "inactive-search",
      entityTypes,
      limit: 12,
    }),
    enabled: relatedShouldSearch,
    placeholderData: keepPreviousData,
  });
  // A placeholder belongs to the prior draft. Never let it appear beneath a
  // newer lexical result set — Related is intentionally a stable, separate
  // section rather than a best-effort append.
  const relatedResults = useMemo(() => {
    if (
      relatedDraft !== draft ||
      related.isPlaceholderData ||
      related.data?.status !== "ready"
    )
      return [];
    const primaryRefs = new Set((primary.data ?? []).map((group) => group.key));
    return related.data.groups.filter((group) => !primaryRefs.has(group.key));
  }, [
    draft,
    primary.data,
    related.data,
    related.isPlaceholderData,
    relatedDraft,
  ]);
  // Session-only; nothing here persists across reloads.
  const [recents, setRecents] = useState<string[]>([]);
  const hasQuery = draft.trim().length > 0;

  return (
    <Stack gap="md" className="container mx-auto p-1">
      <div className="sticky top-[var(--app-chrome-top)] z-20 -mx-1 space-y-1 border-b border-border bg-background px-1 pb-1">
        <div className="relative">
          <Search className="absolute top-1/2 left-2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="search"
            aria-label="Search Cubby"
            placeholder="Search products, recipes, locations..."
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && event.currentTarget.value.trim())
                setRecents((previous) =>
                  uniq([event.currentTarget.value.trim(), ...previous]).slice(
                    0,
                    8,
                  ),
                );
            }}
            className="min-h-11 pl-6 md:min-h-0"
            ref={inputRef}
          />
        </div>
        <SearchFilter
          value={type}
          onChange={(next) =>
            navigate({
              to: "/search",
              search: {
                q: draft || undefined,
                type: next === "all" ? undefined : next,
              },
            })
          }
        />
      </div>
      {hasQuery ? (
        <Stack gap="md">
          {isMobile ? (
            <MobileSearchResults
              data={primary.data ?? []}
              isLoading={primary.isPending}
              error={primary.error}
              onRetry={() => void primary.refetch()}
            />
          ) : (
            <SearchResults
              data={primary.data ?? []}
              isLoading={primary.isPending}
              error={primary.error}
              onRetry={() => void primary.refetch()}
              onPreview={onRowClick}
              onPrefetch={onRowHover}
              onPrefetchEnd={onRowHoverEnd}
            />
          )}
          {relatedResults.length > 0 && (
            <section
              aria-labelledby={relatedHeadingId}
              className="border-t-2 border-foreground pt-2"
            >
              <Row align="baseline" justify="between" className="mb-1">
                <h2
                  id={relatedHeadingId}
                  className="font-heading text-base font-bold"
                >
                  Related
                </h2>
                <span className="font-mono text-2xs text-muted-foreground uppercase">
                  Meaning-based matches
                </span>
              </Row>
              {isMobile ? (
                <MobileSearchResults
                  data={relatedResults}
                  isLoading={false}
                  error={null}
                  onRetry={() => undefined}
                />
              ) : (
                <SearchResults
                  data={relatedResults}
                  isLoading={false}
                  error={null}
                  onRetry={() => undefined}
                  onPreview={onRowClick}
                  onPrefetch={onRowHover}
                  onPrefetchEnd={onRowHoverEnd}
                />
              )}
            </section>
          )}
          {relatedDraft === draft &&
          !related.isPlaceholderData &&
          related.data?.status === "unavailable" &&
          primary.data?.length ? (
            <p className="text-xs text-muted-foreground">
              Related matches are temporarily unavailable.
            </p>
          ) : null}
        </Stack>
      ) : (
        <SearchLanding
          recents={recents}
          clearRecents={() => setRecents([])}
          onSelect={setDraft}
        />
      )}
      <PreviewSheet />
    </Stack>
  );
}

function SearchFilter({
  value,
  onChange,
}: {
  value: SearchType;
  onChange: (value: SearchType) => void;
}) {
  return (
    <Row gap="sm" className="-mx-1 overflow-x-auto px-1 pb-1">
      {filterOptions.map((option) => (
        <Badge
          key={option.value}
          variant={option.value === value ? "default" : "outline"}
          className="min-h-11 min-w-11 shrink-0 cursor-pointer px-2 py-1 text-xs md:min-h-0 md:min-w-0"
          render={
            <button
              type="button"
              aria-label={`Filter by ${option.label}`}
              onClick={() => onChange(option.value)}
            />
          }
        >
          {option.label}
        </Badge>
      ))}
    </Row>
  );
}

function SearchResults({
  data,
  isLoading,
  error,
  onRetry,
  onPreview,
  onPrefetch,
  onPrefetchEnd,
}: {
  data: SearchResultGroup[];
  isLoading: boolean;
  error: unknown;
  onRetry: () => void;
  onPreview: SearchPreviewHandler;
  onPrefetch: SearchPreviewHandler;
  onPrefetchEnd: SearchPreviewHandler;
}) {
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(
    () => new Set(),
  );
  const feedback = getSearchResultsFeedback({
    isLoading,
    error,
    resultCount: data.length,
  });
  if (feedback)
    return (
      <SearchResultsFeedback state={feedback} error={error} onRetry={onRetry} />
    );
  return (
    <div className="border-y border-border">
      {data.map((group) =>
        group.kind === "product" ? (
          <ProductSearchRow
            key={group.key}
            expanded={expandedKeys.has(group.key)}
            group={group}
            onPreview={onPreview}
            onPrefetch={onPrefetch}
            onPrefetchEnd={onPrefetchEnd}
            onToggle={() =>
              setExpandedKeys((current) => {
                const updated = new Set(current);
                if (updated.has(group.key)) updated.delete(group.key);
                else updated.add(group.key);
                return updated;
              })
            }
          />
        ) : (
          <SearchRow
            key={group.key}
            group={group}
            onPreview={onPreview}
            onPrefetch={onPrefetch}
            onPrefetchEnd={onPrefetchEnd}
          />
        ),
      )}
    </div>
  );
}

function SearchRow({
  group,
  onPreview,
  onPrefetch,
  onPrefetchEnd,
}: {
  group: Extract<SearchResultGroup, { kind: "entity" }>;
  onPreview: SearchPreviewHandler;
  onPrefetch: SearchPreviewHandler;
  onPrefetchEnd: SearchPreviewHandler;
}) {
  const item = group.primary;
  const previewRow = { original: item };
  return (
    <div className="group flex items-center gap-4 border-b border-border px-2 py-2 last:border-b-0 hover:bg-muted/45">
      <SearchResultMedia item={item} variant="list" />
      <div className="min-w-0 flex-1">
        <Link
          {...getSearchResultRoute(item)}
          onPointerEnter={(event) => {
            if (event.pointerType !== "touch") onPrefetch(previewRow);
          }}
          onPointerLeave={(event) => {
            if (event.pointerType !== "touch") onPrefetchEnd(previewRow);
          }}
          onFocus={() => onPrefetch(previewRow)}
          onBlur={() => onPrefetchEnd(previewRow)}
          className="block truncate text-sm font-medium hover:text-primary"
        >
          {item.title}
        </Link>
        {item.subtitle && (
          <span className="block truncate text-xs text-muted-foreground">
            {item.subtitle}
          </span>
        )}
        {group.linkedProduct && (
          <span className="block truncate text-2xs text-muted-foreground">
            Linked to {group.linkedProduct.title}
          </span>
        )}
      </div>
      <button
        type="button"
        onClick={() => onPreview(previewRow)}
        className="shrink-0 font-mono text-2xs text-muted-foreground uppercase hover:text-primary"
      >
        Preview
      </button>
      <div className="hidden max-w-44 shrink-0 text-right sm:block">
        <span className="block truncate font-mono text-2xs text-muted-foreground uppercase">
          {entities[entityTypeMap[item.entityType]].label}
        </span>
        <span className="block truncate font-mono text-2xs text-foreground tabular-nums">
          {item.id}
        </span>
        <span
          className="block truncate text-2xs text-muted-foreground"
          title={item.matchReason}
        >
          {getSearchMatchText(item)}
        </span>
      </div>
    </div>
  );
}

const formatPlacement = (placement: SearchInventoryPlacement) => {
  const { value, upperValue, unit } = placement.amount;
  return `${value}${upperValue === undefined ? "" : `–${upperValue}`} ${unit} · ${enumFieldLabel("inventory", "placement", placement.placement)}`;
};

const placementSearchDestination = (
  group: Extract<SearchResultGroup, { kind: "product" }>,
  placement: SearchInventoryPlacement,
): SearchDestination => ({
  id: placement.id,
  entityType: "inventory",
  title: group.primary.title,
  subtitle: placement.locationPath,
  typeHint: group.primary.typeHint,
  imageUrl: group.primary.imageUrl,
});

const componentPlacementSearchDestination = (
  componentPlacement: SearchComponentPlacement,
): SearchDestination => ({
  ...componentPlacement.component,
  id: componentPlacement.placement.id,
  entityType: "inventory",
  subtitle: componentPlacement.placement.locationPath,
});

const searchProductSummary = (
  group: Extract<SearchResultGroup, { kind: "product" }>,
) => {
  const placements = group.placements.length;
  const componentPlacements = group.componentPlacements.length;
  const activity = group.matchedActivity.length;
  const locationPaths = [
    ...group.placements.map((placement) => placement.locationPath),
    ...group.componentPlacements.map(({ placement }) => placement.locationPath),
  ];
  return [
    ...(placements > 0
      ? [
          `${placements} ${componentPlacements > 0 ? "direct " : ""}${placements === 1 ? "placement" : "placements"}`,
        ]
      : componentPlacements === 0
        ? ["0 placements"]
        : []),
    ...(componentPlacements > 0 ? ["Kit contents placed"] : []),
    ...[...new Set(locationPaths)].slice(0, 2),
    ...(activity > 0
      ? [`${activity} matching ${activity === 1 ? "record" : "records"}`]
      : []),
  ].join(" · ");
};

function ProductSearchRow({
  expanded,
  group,
  onPreview,
  onPrefetch,
  onPrefetchEnd,
  onToggle,
}: {
  expanded: boolean;
  group: Extract<SearchResultGroup, { kind: "product" }>;
  onPreview: SearchPreviewHandler;
  onPrefetch: SearchPreviewHandler;
  onPrefetchEnd: SearchPreviewHandler;
  onToggle: () => void;
}) {
  const previewRow = { original: group.primary };
  const regionId = `search-family-${group.primary.id}`;
  const hasChildren =
    group.placements.length > 0 ||
    group.componentPlacements.length > 0 ||
    group.matchedActivity.length > 0;
  return (
    <div className="border-b border-border last:border-b-0">
      <div className="group flex items-center gap-3 px-2 py-2 hover:bg-muted/45">
        {hasChildren && (
          <button
            type="button"
            aria-label={`${expanded ? "Collapse" : "Expand"} ${group.primary.title} placements and matching records`}
            aria-expanded={expanded}
            aria-controls={regionId}
            onClick={onToggle}
            className="flex size-8 shrink-0 items-center justify-center text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-primary"
          >
            <ChevronRight
              className={cn(
                "size-4 transition-transform motion-reduce:transition-none",
                expanded && "rotate-90",
              )}
            />
          </button>
        )}
        <SearchResultMedia item={group.primary} variant="list" />
        <div className="min-w-0 flex-1">
          <Link
            {...getSearchResultRoute(group.primary)}
            onPointerEnter={(event) => {
              if (event.pointerType !== "touch") onPrefetch(previewRow);
            }}
            onPointerLeave={(event) => {
              if (event.pointerType !== "touch") onPrefetchEnd(previewRow);
            }}
            onFocus={() => onPrefetch(previewRow)}
            onBlur={() => onPrefetchEnd(previewRow)}
            className="block truncate text-sm font-medium hover:text-primary"
          >
            {group.primary.title}
          </Link>
          <span className="block truncate text-xs text-muted-foreground">
            {[group.primary.subtitle, searchProductSummary(group)]
              .filter(Boolean)
              .join(" · ")}
          </span>
        </div>
        <button
          type="button"
          onClick={() => onPreview(previewRow)}
          className="shrink-0 font-mono text-2xs text-muted-foreground uppercase hover:text-primary"
        >
          Preview
        </button>
        <div className="hidden max-w-44 shrink-0 text-right sm:block">
          <span className="block font-mono text-2xs text-muted-foreground uppercase">
            Product
          </span>
          <span className="block font-mono text-2xs text-foreground tabular-nums">
            {group.primary.id}
          </span>
          <span
            className="block max-w-44 truncate text-2xs text-muted-foreground"
            title={group.bestMatch.matchReason}
          >
            {getSearchMatchText(group.bestMatch)}
          </span>
        </div>
      </div>
      {expanded && hasChildren && (
        <fieldset
          id={regionId}
          aria-label={`${group.primary.title} placements and matching records`}
          className="border-t border-border bg-muted/25 py-1"
        >
          {group.placements.map((placement) => {
            const destination = placementSearchDestination(group, placement);
            return (
              <Link
                key={placement.id}
                {...getSearchResultRoute(destination)}
                className="flex min-h-11 items-center gap-3 px-5 py-1.5 hover:bg-muted/60"
              >
                <MapPin className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs font-medium">
                    {placement.locationPath}
                  </span>
                  <span className="block truncate text-2xs text-muted-foreground">
                    {formatPlacement(placement)}
                  </span>
                </span>
                <span className="font-mono text-2xs text-muted-foreground tabular-nums">
                  {placement.id}
                </span>
              </Link>
            );
          })}
          {group.componentPlacements.map((componentPlacement) => {
            const destination =
              componentPlacementSearchDestination(componentPlacement);
            return (
              <Link
                key={`${componentPlacement.component.id}:${componentPlacement.placement.id}`}
                {...getSearchResultRoute(destination)}
                className="flex min-h-11 items-center gap-3 px-5 py-1.5 hover:bg-muted/60"
              >
                <SearchResultMedia item={componentPlacement.component} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs font-medium">
                    {componentPlacement.component.title}
                  </span>
                  <span className="block truncate text-2xs text-muted-foreground">
                    {componentPlacement.componentQuantity > 1
                      ? `${componentPlacement.componentQuantity}× kit content`
                      : "Kit content"}{" "}
                    · {componentPlacement.placement.locationPath} ·{" "}
                    {formatPlacement(componentPlacement.placement)}
                  </span>
                </span>
                <span className="font-mono text-2xs text-muted-foreground tabular-nums">
                  {componentPlacement.placement.id}
                </span>
              </Link>
            );
          })}
          {group.matchedActivity.map((item) => (
            <Link
              key={`${item.entityType}:${item.id}`}
              {...getSearchResultRoute(item)}
              className="flex min-h-11 items-center gap-3 px-5 py-1.5 hover:bg-muted/60"
            >
              <SearchResultMedia item={item} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs font-medium">
                  {item.title}
                </span>
                <span className="block truncate text-2xs text-muted-foreground">
                  {entities[entityTypeMap[item.entityType]].label} · {item.id} ·
                  Linked to {group.primary.title}
                </span>
              </span>
              <span className="max-w-36 truncate text-2xs text-muted-foreground">
                {getSearchMatchText(item)}
              </span>
            </Link>
          ))}
        </fieldset>
      )}
    </div>
  );
}

function MobileSearchResults({
  data,
  isLoading,
  error,
  onRetry,
}: {
  data: SearchResultGroup[];
  isLoading: boolean;
  error: unknown;
  onRetry: () => void;
}) {
  const navigate = useNavigate();
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(
    () => new Set(),
  );
  const feedback = getSearchResultsFeedback({
    isLoading,
    error,
    resultCount: data.length,
  });
  if (feedback === "loading") return <MobileCardSkeletonList count={6} />;
  if (feedback)
    return (
      <SearchResultsFeedback
        state={feedback}
        error={error}
        onRetry={onRetry}
        mobile
      />
    );
  return (
    <div className="border-y border-border">
      {data.map((group) => {
        if (group.kind === "product") {
          const expanded = expandedKeys.has(group.key);
          const hasChildren =
            group.placements.length > 0 ||
            group.componentPlacements.length > 0 ||
            group.matchedActivity.length > 0;
          const regionId = `mobile-search-family-${group.primary.id}`;
          return (
            <div
              key={group.key}
              className="border-b border-border last:border-b-0"
            >
              <div className="flex items-stretch">
                <div className="min-w-0 flex-1">
                  <MobileCard
                    variant="row"
                    title={group.primary.title}
                    subtitle={searchProductSummary(group)}
                    imageSlot={
                      <SearchResultMedia
                        item={group.primary}
                        variant="mobile"
                      />
                    }
                    rightValues={[group.primary.id, "Product"]}
                    // A real `<Link>` href gives TanStack's touchstart intent
                    // preload (`defaultPreload: "intent"` in `src/router.tsx`)
                    // a chance to resolve the detail loader before the tap
                    // releases, so a phone tap usually skips the pending
                    // skeleton. `onClick` stays for the whole-row body tap
                    // (`handleBodyClick` skips clicks that land on the title
                    // `<a>` itself).
                    detailsHref={getSearchResultHref(group.primary)}
                    onClick={() =>
                      navigate(getSearchResultRoute(group.primary))
                    }
                  />
                </div>
                {hasChildren && (
                  <button
                    type="button"
                    aria-label={`${expanded ? "Collapse" : "Expand"} ${group.primary.title} placements and matching records`}
                    aria-expanded={expanded}
                    aria-controls={regionId}
                    onClick={() =>
                      setExpandedKeys((current) => {
                        const updated = new Set(current);
                        if (updated.has(group.key)) updated.delete(group.key);
                        else updated.add(group.key);
                        return updated;
                      })
                    }
                    className="flex min-h-11 min-w-11 items-center justify-center text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-primary"
                  >
                    <ChevronRight
                      className={cn(
                        "size-4 transition-transform motion-reduce:transition-none",
                        expanded && "rotate-90",
                      )}
                    />
                  </button>
                )}
              </div>
              {expanded && hasChildren && (
                <fieldset
                  id={regionId}
                  aria-label={`${group.primary.title} placements and matching records`}
                  className="border-t border-border bg-muted/25 py-1"
                >
                  {group.placements.map((placement) => {
                    const destination = placementSearchDestination(
                      group,
                      placement,
                    );
                    return (
                      <Link
                        key={placement.id}
                        {...getSearchResultRoute(destination)}
                        className="flex min-h-11 items-center gap-3 px-3 py-1.5 hover:bg-muted/60"
                      >
                        <MapPin className="size-4 shrink-0 text-muted-foreground" />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-xs font-medium">
                            {placement.locationPath}
                          </span>
                          <span className="block truncate text-2xs text-muted-foreground">
                            {formatPlacement(placement)}
                          </span>
                        </span>
                        <span className="font-mono text-2xs text-muted-foreground tabular-nums">
                          {placement.id}
                        </span>
                      </Link>
                    );
                  })}
                  {group.componentPlacements.map((componentPlacement) => {
                    const destination =
                      componentPlacementSearchDestination(componentPlacement);
                    return (
                      <Link
                        key={`${componentPlacement.component.id}:${componentPlacement.placement.id}`}
                        {...getSearchResultRoute(destination)}
                        className="flex min-h-11 items-center gap-3 px-3 py-1.5 hover:bg-muted/60"
                      >
                        <SearchResultMedia
                          item={componentPlacement.component}
                          variant="command"
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-xs font-medium">
                            {componentPlacement.component.title}
                          </span>
                          <span className="block truncate text-2xs text-muted-foreground">
                            {componentPlacement.componentQuantity > 1
                              ? `${componentPlacement.componentQuantity}× kit content`
                              : "Kit content"}{" "}
                            · {componentPlacement.placement.locationPath} ·{" "}
                            {formatPlacement(componentPlacement.placement)}
                          </span>
                        </span>
                        <span className="font-mono text-2xs text-muted-foreground tabular-nums">
                          {componentPlacement.placement.id}
                        </span>
                      </Link>
                    );
                  })}
                  {group.matchedActivity.map((item) => (
                    <Link
                      key={`${item.entityType}:${item.id}`}
                      {...getSearchResultRoute(item)}
                      className="flex min-h-11 items-center gap-3 px-3 py-1.5 hover:bg-muted/60"
                    >
                      <SearchResultMedia item={item} variant="command" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-xs font-medium">
                          {item.title}
                        </span>
                        <span className="block truncate text-2xs text-muted-foreground">
                          {entities[entityTypeMap[item.entityType]].label} ·{" "}
                          {item.id} · Linked to {group.primary.title}
                        </span>
                      </span>
                    </Link>
                  ))}
                </fieldset>
              )}
            </div>
          );
        }
        const item = group.primary;
        return (
          <MobileCard
            key={group.key}
            variant="row"
            title={item.title}
            subtitle={
              group.linkedProduct
                ? [item.subtitle, `Linked to ${group.linkedProduct.title}`]
                    .filter(Boolean)
                    .join(" · ")
                : item.subtitle
            }
            imageSlot={<SearchResultMedia item={item} variant="mobile" />}
            rightValues={[
              item.id,
              entities[entityTypeMap[item.entityType]].label,
            ]}
            detailsHref={getSearchResultHref(item)}
            onClick={() => navigate(getSearchResultRoute(item))}
          />
        );
      })}
    </div>
  );
}

export type SearchResultsFeedbackState = "loading" | "error" | "empty";

export function getSearchResultsFeedback({
  isLoading,
  error,
  resultCount,
}: {
  isLoading: boolean;
  error: unknown;
  resultCount: number;
}): SearchResultsFeedbackState | null {
  if (isLoading) return "loading";
  if (error) return "error";
  return resultCount === 0 ? "empty" : null;
}

export function SearchResultsFeedback({
  state,
  error,
  onRetry,
  mobile = false,
}: {
  state: SearchResultsFeedbackState;
  error?: unknown;
  onRetry: () => void;
  mobile?: boolean;
}) {
  if (state === "loading") {
    return (
      <div className="py-8 text-center text-sm text-muted-foreground">
        Searching…
      </div>
    );
  }
  if (state === "error") {
    return (
      <div
        className={cn(
          "flex justify-center py-8",
          mobile && "min-h-32 items-center",
        )}
      >
        <ErrorDisplay error={error} title="search results" onRetry={onRetry} />
      </div>
    );
  }
  return (
    <div
      className={cn(
        "py-8 text-center text-sm text-muted-foreground",
        mobile && "flex min-h-32 items-center justify-center",
      )}
    >
      No direct matches.
    </div>
  );
}

function SearchLanding({
  recents,
  clearRecents,
  onSelect,
}: {
  recents: string[];
  clearRecents: () => void;
  onSelect: (value: string) => void;
}) {
  return (
    <Stack gap="md">
      {recents.length > 0 && (
        <Stack gap="xs">
          <Row align="center" justify="between" className="px-1">
            <span className="eyebrow font-medium">Recent</span>
            <button
              type="button"
              onClick={clearRecents}
              className="font-mono text-2xs text-muted-foreground uppercase hover:text-foreground"
            >
              Clear
            </button>
          </Row>
          {recents.map((term) => (
            <Row
              as="button"
              align="center"
              gap="sm"
              key={term}
              type="button"
              onClick={() => onSelect(term)}
              className="w-full px-2 py-2 text-left text-sm hover:bg-muted"
            >
              <Search className="size-4 shrink-0 text-muted-foreground" />
              <span className="truncate">{term}</span>
            </Row>
          ))}
        </Stack>
      )}
      {recents.length === 0 && (
        <div className="flex h-48 flex-col items-center justify-center gap-2 text-muted-foreground">
          <Search className="size-8 opacity-40" />
          <span className="text-sm">Start typing to search across Cubby</span>
        </div>
      )}
    </Stack>
  );
}
