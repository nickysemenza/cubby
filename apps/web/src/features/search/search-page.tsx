import type {
  SearchDestination,
  SearchResultGroup,
  SearchType,
} from "@cubby/schemas/search";
import { searchableEntities } from "@cubby/schemas/search";
import { MagnifyingGlassIcon } from "@phosphor-icons/react/dist/csr/MagnifyingGlass";
import { useDebouncedValue } from "@tanstack/react-pacer";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { uniq } from "es-toolkit";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";

import { entities } from "~/entity/entities";
import {
  SearchFacts,
  SearchShortcode,
} from "~/entity/presentation/search-facts";
import { search } from "~/integrations/tanstack-query/generated/domains/search.gen";
import { cn } from "~/lib/utils";
import { MobileCard } from "~/ui/data-table/mobile-card";
import { ErrorDisplay } from "~/ui/feedback/error-display";
import { MobileCardSkeletonList } from "~/ui/feedback/mobile-card-skeleton";
import { useIsMobile } from "~/ui/hooks/use-mobile";
import { Row, Stack } from "~/ui/layout";
import { Badge } from "~/ui/primitives/badge";
import { Button } from "~/ui/primitives/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "~/ui/primitives/dropdown-menu";
import { Input } from "~/ui/primitives/input";
import { Skeleton } from "~/ui/primitives/skeleton";

import {
  type EntityPreviewRowData,
  useEntityPreview,
} from "../../entity/hooks/use-entity-preview";
import {
  getSearchResultHref,
  getSearchResultRoute,
  SearchResultMedia,
  searchHitContext,
} from "../../entity/presentation/search-utils";
import {
  ProductFamilyChildContent,
  productFamilyChildren,
  productFamilyHasChildren,
  ProductFamilyRegion,
  type ProductSearchGroup,
  productFamilySummary,
  ProductFamilyToggle,
  useExpandedFamilies,
} from "./product-family";

interface SearchPageProps {
  query?: string;
  type: SearchType;
}

interface SearchPreviewRow {
  original: SearchDestination & EntityPreviewRowData;
}

type SearchPreviewHandler = (row: SearchPreviewRow) => void;

const VISIBLE_FILTER_COUNT = 8;
const filterOptions: Array<{ value: SearchType; label: string }> = [
  { value: "all", label: "All" },
  ...searchableEntities.map((entityKind) => ({
    value: entityKind,
    label: entities[entityKind].label,
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
                <span className="text-xs font-medium text-muted-foreground">
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
  // Every type stays reachable; the row itself never overflows the page.
  const lead = filterOptions.slice(0, VISIBLE_FILTER_COUNT);
  const selectedOption = filterOptions.find((option) => option.value === value);
  const visible =
    selectedOption && !lead.includes(selectedOption)
      ? [...lead.slice(0, -1), selectedOption]
      : lead;
  const overflow = filterOptions.filter((option) => !visible.includes(option));
  return (
    <Row gap="sm" className="-mx-1 flex-wrap px-1 pb-1">
      {visible.map((option) => (
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
      {overflow.length > 0 && (
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button variant="outline" size="xs">
                More
              </Button>
            }
          />
          <DropdownMenuContent align="start">
            {overflow.map((option) => (
              <DropdownMenuItem
                key={option.value}
                onClick={() => onChange(option.value)}
              >
                {option.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
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
  const families = useExpandedFamilies();
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
            expanded={families.isExpanded(group.key)}
            group={group}
            onPreview={onPreview}
            onPrefetch={onPrefetch}
            onPrefetchEnd={onPrefetchEnd}
            onToggle={() => families.toggle(group.key)}
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
        {searchHitContext(item) && (
          <span className="block truncate text-xs text-muted-foreground">
            {searchHitContext(item)}
          </span>
        )}
        {group.linkedProduct && (
          <span className="block truncate text-2xs text-muted-foreground">
            Linked to {group.linkedProduct.title}
          </span>
        )}
      </div>
      <PreviewButton onClick={() => onPreview(previewRow)} />
      <SearchFacts item={item} />
      <SearchShortcode item={item} />
    </div>
  );
}

function PreviewButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="shrink-0 text-xs font-medium text-muted-foreground hover:text-primary"
    >
      Preview
    </button>
  );
}

/** A product row's expanded children: every placement, kit placement, and matched record. */
function ProductFamilyLinks({
  id,
  group,
  compact = false,
}: {
  id: string;
  group: ProductSearchGroup;
  /** The phone layout: tighter inset, no match text. */
  compact?: boolean;
}) {
  return (
    <ProductFamilyRegion id={id} group={group} className="border-t">
      {productFamilyChildren(group).children.map((child) => (
        <Link
          key={child.key}
          {...getSearchResultRoute(child.destination)}
          className={cn(
            "flex min-h-11 items-center gap-3 py-1.5 hover:bg-muted/60",
            compact ? "px-3" : "px-5",
          )}
        >
          <ProductFamilyChildContent child={child} showMatch={!compact} />
        </Link>
      ))}
    </ProductFamilyRegion>
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
  group: ProductSearchGroup;
  onPreview: SearchPreviewHandler;
  onPrefetch: SearchPreviewHandler;
  onPrefetchEnd: SearchPreviewHandler;
  onToggle: () => void;
}) {
  const previewRow = { original: group.primary };
  const regionId = `search-family-${group.primary.id}`;
  const hasChildren = productFamilyHasChildren(group);
  return (
    <div className="border-b border-border last:border-b-0">
      <div className="group flex items-center gap-3 px-2 py-2 hover:bg-muted/45">
        {hasChildren && (
          <ProductFamilyToggle
            group={group}
            expanded={expanded}
            regionId={regionId}
            onToggle={onToggle}
            className="size-8"
          />
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
            {[group.primary.facts.join(" · "), productFamilySummary(group)]
              .filter(Boolean)
              .join(" · ")}
          </span>
        </div>
        <PreviewButton onClick={() => onPreview(previewRow)} />
        <SearchFacts item={group.primary} />
        <SearchShortcode item={group.primary} />
      </div>
      {expanded && hasChildren && (
        <ProductFamilyLinks id={regionId} group={group} />
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
  const families = useExpandedFamilies();
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
          const expanded = families.isExpanded(group.key);
          const hasChildren = productFamilyHasChildren(group);
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
                    subtitle={searchHitContext(group.primary) ?? undefined}
                    imageSlot={
                      <SearchResultMedia
                        item={group.primary}
                        variant="mobile"
                      />
                    }
                    rightValues={[
                      <SearchShortcode key="code" item={group.primary} />,
                    ]}
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
                  >
                    <SearchFacts item={group.primary} mobile />
                  </MobileCard>
                </div>
                {hasChildren && (
                  <ProductFamilyToggle
                    group={group}
                    expanded={expanded}
                    regionId={regionId}
                    onToggle={() => families.toggle(group.key)}
                    className="min-h-11 min-w-11 hover:bg-muted"
                  />
                )}
              </div>
              {expanded && hasChildren && (
                <ProductFamilyLinks id={regionId} group={group} compact />
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
                ? [
                    searchHitContext(item),
                    `Linked to ${group.linkedProduct.title}`,
                  ]
                    .filter(Boolean)
                    .join(" · ")
                : (searchHitContext(item) ?? undefined)
            }
            imageSlot={<SearchResultMedia item={item} variant="mobile" />}
            rightValues={[<SearchShortcode key="code" item={item} />]}
            detailsHref={getSearchResultHref(item)}
            onClick={() => navigate(getSearchResultRoute(item))}
          >
            <SearchFacts item={item} mobile />
          </MobileCard>
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
      <output aria-label="Searching" className="block space-y-1 py-2">
        {Array.from({ length: 8 }, (_, index) => (
          <Skeleton key={index} className="h-(--table-row-height) w-full" />
        ))}
      </output>
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
              className="text-xs font-medium text-muted-foreground hover:text-foreground"
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
