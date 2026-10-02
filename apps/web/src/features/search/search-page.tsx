import type {
  SearchComponentPlacement,
  SearchDestination,
  SearchInventoryPlacement,
  SearchResultGroup,
  SearchType,
} from "@cubby/schemas/search";
import { searchableEntities } from "@cubby/schemas/search";
import { CaretRightIcon } from "@phosphor-icons/react/dist/csr/CaretRight";
import { MagnifyingGlassIcon } from "@phosphor-icons/react/dist/csr/MagnifyingGlass";
import { MapPinIcon } from "@phosphor-icons/react/dist/csr/MapPin";
import { useDebouncedValue } from "@tanstack/react-pacer";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { uniq } from "es-toolkit";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";

import { MobileCard } from "~/entity/components/mobile-card";
import { entities } from "~/entity/entities";
import { enumFieldLabel } from "~/entity/enum-field-display";
import { search } from "~/integrations/tanstack-query/generated/catalog.gen";
import { cn } from "~/lib/utils";
import { ErrorDisplay } from "~/ui/feedback/error-display";
import { MobileCardSkeletonList } from "~/ui/feedback/mobile-card-skeleton";
import { useIsMobile } from "~/ui/hooks/useMobile";
import { Row, Stack } from "~/ui/layout";
import { Badge } from "~/ui/primitives/badge";
import { Input } from "~/ui/primitives/input";

import {
  type EntityPreviewRowData,
  useEntityPreview,
} from "../../ui/hooks/useEntityPreview";
import {
  entityKindMap,
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
  ...searchableEntities.map((entityKind) => ({
    value: entityKind,
    label: entities[entityKindMap[entityKind]].label,
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
  const entityKinds = type === "all" ? undefined : [type];
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
      entityKinds,
      limit: 50,
    }),
    enabled: primaryShouldSearch,
    placeholderData: keepPreviousData,
  });
  const related = useQuery({
    ...search.relatedGrouped.queryOptions({
      query: relatedShouldSearch ? relatedDraft : "inactive-search",
      entityKinds,
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
          <MagnifyingGlassIcon className="absolute top-1/2 left-2 size-4 -translate-y-1/2 text-muted-foreground" />
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
      <PreviewButton onClick={() => onPreview(previewRow)} />
      <div className="hidden max-w-44 shrink-0 text-right sm:block">
        <span className="block truncate font-mono text-2xs text-muted-foreground uppercase">
          {entities[entityKindMap[item.entityKind]].label}
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
  entityKind: "inventory",
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
  entityKind: "inventory",
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

function PreviewButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="shrink-0 font-mono text-2xs text-muted-foreground uppercase hover:text-primary"
    >
      Preview
    </button>
  );
}

function PlacementRow({
  destination,
  compact,
  leading,
  title,
  detail,
  trailing,
}: {
  destination: SearchDestination;
  compact: boolean;
  leading: ReactNode;
  title: ReactNode;
  detail: ReactNode;
  trailing: ReactNode;
}) {
  return (
    <Link
      {...getSearchResultRoute(destination)}
      className={cn(
        "flex min-h-11 items-center gap-3 py-1.5 hover:bg-muted/60",
        compact ? "px-3" : "px-5",
      )}
    >
      {leading}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs font-medium">{title}</span>
        <span className="block truncate text-2xs text-muted-foreground">
          {detail}
        </span>
      </span>
      {trailing}
    </Link>
  );
}

const placementCode = (id: string) => (
  <span className="font-mono text-2xs text-muted-foreground tabular-nums">
    {id}
  </span>
);

/** A product row's expanded children: its placements, kit placements, and matched activity. */
function ProductFamilyRegion({
  id,
  group,
  compact = false,
}: {
  id: string;
  group: Extract<SearchResultGroup, { kind: "product" }>;
  /** The phone layout: tighter inset, command-size media, no match text. */
  compact?: boolean;
}) {
  const mediaVariant = compact ? "command" : undefined;
  return (
    <fieldset
      id={id}
      aria-label={`${group.primary.title} placements and matching records`}
      className="border-t border-border bg-muted/25 py-1"
    >
      {group.placements.map((placement) => (
        <PlacementRow
          key={placement.id}
          destination={placementSearchDestination(group, placement)}
          compact={compact}
          leading={
            <MapPinIcon className="size-4 shrink-0 text-muted-foreground" />
          }
          title={placement.locationPath}
          detail={formatPlacement(placement)}
          trailing={placementCode(placement.id)}
        />
      ))}
      {group.componentPlacements.map((componentPlacement) => (
        <PlacementRow
          key={`${componentPlacement.component.id}:${componentPlacement.placement.id}`}
          destination={componentPlacementSearchDestination(componentPlacement)}
          compact={compact}
          leading={
            <SearchResultMedia
              item={componentPlacement.component}
              variant={mediaVariant}
            />
          }
          title={componentPlacement.component.title}
          detail={
            <>
              {componentPlacement.componentQuantity > 1
                ? `${componentPlacement.componentQuantity}× kit content`
                : "Kit content"}{" "}
              · {componentPlacement.placement.locationPath} ·{" "}
              {formatPlacement(componentPlacement.placement)}
            </>
          }
          trailing={placementCode(componentPlacement.placement.id)}
        />
      ))}
      {group.matchedActivity.map((item) => (
        <PlacementRow
          key={`${item.entityKind}:${item.id}`}
          destination={item}
          compact={compact}
          leading={<SearchResultMedia item={item} variant={mediaVariant} />}
          title={item.title}
          detail={`${entities[entityKindMap[item.entityKind]].label} · ${item.id} · Linked to ${group.primary.title}`}
          trailing={
            compact ? null : (
              <span className="max-w-36 truncate text-2xs text-muted-foreground">
                {getSearchMatchText(item)}
              </span>
            )
          }
        />
      ))}
    </fieldset>
  );
}

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
            <CaretRightIcon
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
        <PreviewButton onClick={() => onPreview(previewRow)} />
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
        <ProductFamilyRegion id={regionId} group={group} />
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
                    <CaretRightIcon
                      className={cn(
                        "size-4 transition-transform motion-reduce:transition-none",
                        expanded && "rotate-90",
                      )}
                    />
                  </button>
                )}
              </div>
              {expanded && hasChildren && (
                <ProductFamilyRegion id={regionId} group={group} compact />
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
              entities[entityKindMap[item.entityKind]].label,
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
              <MagnifyingGlassIcon className="size-4 shrink-0 text-muted-foreground" />
              <span className="truncate">{term}</span>
            </Row>
          ))}
        </Stack>
      )}
      {recents.length === 0 && (
        <div className="flex h-48 flex-col items-center justify-center gap-2 text-muted-foreground">
          <MagnifyingGlassIcon className="size-8 opacity-40" />
          <span className="text-sm">Start typing to search across Cubby</span>
        </div>
      )}
    </Stack>
  );
}
