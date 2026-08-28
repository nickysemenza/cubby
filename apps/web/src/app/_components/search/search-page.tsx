import type { SearchableEntity, SearchType } from "@cubby/schemas/search";
import { searchableEntities } from "@cubby/schemas/search";
import { useDebouncedValue } from "@tanstack/react-pacer";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { uniq } from "es-toolkit";
import { Search } from "lucide-react";
import { useEffect, useId, useMemo, useState } from "react";
import { z } from "zod";

import { MobileCard } from "~/components/entity/mobile-card";
import { MobileCardSkeletonList } from "~/components/feedback/mobile-card-skeleton";
import { Row, Stack } from "~/components/layout";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { EntityIcon, entities } from "~/entities/entities";
import { focusOnMount } from "~/hooks/focus-on-mount";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import { useIsMobile } from "~/hooks/useMobile";
import { search } from "~/lib/search.functions";
import { cn } from "~/lib/utils";

import { getRecents, pushRecent } from "../command-menu/recents";
import {
  type EntityPreviewRowData,
  useEntityPreview,
} from "../hooks/useEntityPreview";
import {
  entityTypeMap,
  getSearchMatchText,
  getSearchResultRoute,
  rememberSearchResult,
  type SearchHit,
  SearchResultMedia,
} from "./search-utils";

interface SearchPageProps {
  query?: string;
  type: SearchType;
}

interface SearchPreviewRow {
  original: SearchHit & EntityPreviewRowData;
}

type SearchPreviewHandler = (row: SearchPreviewRow) => void;
const recentSearchesSchema = z.array(z.string());

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
  const [debouncedDraft] = useDebouncedValue(draft, { wait: 150 });
  const [relatedDraft] = useDebouncedValue(draft, { wait: 450 });
  const entityTypes: SearchableEntity[] | undefined =
    type === "all" ? undefined : [type];
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
    ...search.find.queryOptions({
      // Disabled queries still construct and validate their options.
      query: primaryShouldSearch ? debouncedDraft : "inactive-search",
      entityTypes,
      limit: 50,
    }),
    enabled: primaryShouldSearch,
    placeholderData: keepPreviousData,
  });
  const related = useQuery({
    ...search.related.queryOptions({
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
    const primaryRefs = new Set(
      (primary.data ?? []).map((hit) => `${hit.entityType}:${hit.id}`),
    );
    return related.data.results.filter(
      (hit) => !primaryRefs.has(`${hit.entityType}:${hit.id}`),
    );
  }, [
    draft,
    primary.data,
    related.data,
    related.isPlaceholderData,
    relatedDraft,
  ]);
  const jumps = useMemo(() => getRecents(), []);
  const [recents, setRecents] = useLocalStorage(
    "cubby:recent-searches",
    recentSearchesSchema,
    [],
  );
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
            ref={focusOnMount}
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
          jumps={jumps}
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
  data: SearchHit[];
  isLoading: boolean;
  error: unknown;
  onRetry: () => void;
  onPreview: SearchPreviewHandler;
  onPrefetch: SearchPreviewHandler;
  onPrefetchEnd: SearchPreviewHandler;
}) {
  const feedback = getSearchResultsFeedback({
    isLoading,
    error,
    resultCount: data.length,
  });
  if (feedback)
    return <SearchResultsFeedback state={feedback} onRetry={onRetry} />;
  return (
    <div className="border-y border-border">
      {data.map((item) => (
        <SearchRow
          key={`${item.entityType}:${item.id}`}
          item={item}
          onPreview={onPreview}
          onPrefetch={onPrefetch}
          onPrefetchEnd={onPrefetchEnd}
        />
      ))}
    </div>
  );
}

function SearchRow({
  item,
  onPreview,
  onPrefetch,
  onPrefetchEnd,
}: {
  item: SearchHit;
  onPreview: SearchPreviewHandler;
  onPrefetch: SearchPreviewHandler;
  onPrefetchEnd: SearchPreviewHandler;
}) {
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
          onClick={() => rememberSearchResult(item)}
          className="block truncate text-sm font-medium hover:text-primary"
        >
          {item.title}
        </Link>
        {item.subtitle && (
          <span className="block truncate text-xs text-muted-foreground">
            {item.subtitle}
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

function MobileSearchResults({
  data,
  isLoading,
  error,
  onRetry,
}: {
  data: SearchHit[];
  isLoading: boolean;
  error: unknown;
  onRetry: () => void;
}) {
  const navigate = useNavigate();
  const feedback = getSearchResultsFeedback({
    isLoading,
    error,
    resultCount: data.length,
  });
  if (feedback === "loading") return <MobileCardSkeletonList count={6} />;
  if (feedback)
    return <SearchResultsFeedback state={feedback} onRetry={onRetry} mobile />;
  return (
    <div className="border-y border-border">
      {data.map((item) => (
        <MobileCard
          key={`${item.entityType}:${item.id}`}
          variant="row"
          title={item.title}
          subtitle={item.subtitle}
          imageSlot={<SearchResultMedia item={item} variant="mobile" />}
          rightValues={[
            item.id,
            entities[entityTypeMap[item.entityType]].label,
          ]}
          onClick={() => {
            rememberSearchResult(item);
            navigate(getSearchResultRoute(item));
          }}
        />
      ))}
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
  onRetry,
  mobile = false,
}: {
  state: SearchResultsFeedbackState;
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
      <Stack
        role="alert"
        gap="sm"
        className={cn(
          "items-center justify-center py-8 text-sm",
          mobile && "min-h-32",
        )}
      >
        <p className="text-destructive">Search could not load.</p>
        <Button type="button" variant="outline" onClick={onRetry}>
          Try again
        </Button>
      </Stack>
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
  jumps,
  recents,
  clearRecents,
  onSelect,
}: {
  jumps: ReturnType<typeof getRecents>;
  recents: string[];
  clearRecents: () => void;
  onSelect: (value: string) => void;
}) {
  return (
    <Stack gap="md">
      {jumps.length > 0 && (
        <Stack gap="xs">
          <span className="px-1 eyebrow font-medium">Jump back</span>
          {jumps.map((jump) => {
            const entity = entityTypeMap[jump.entityType];
            return (
              <Row
                as="button"
                align="center"
                gap="sm"
                key={`${jump.entityType}-${jump.id}`}
                type="button"
                onClick={() => {
                  pushRecent(jump);
                  onSelect(jump.name);
                }}
                className="w-full px-2 py-2 text-left text-sm hover:bg-muted"
              >
                <EntityIcon
                  entity={entity}
                  className={cn("size-4", entities[entity].color.text)}
                />
                <span className="truncate">{jump.name}</span>
              </Row>
            );
          })}
        </Stack>
      )}
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
      {jumps.length === 0 && recents.length === 0 && (
        <div className="flex h-48 flex-col items-center justify-center gap-2 text-muted-foreground">
          <Search className="size-8 opacity-40" />
          <span className="text-sm">Start typing to search across Cubby</span>
        </div>
      )}
    </Stack>
  );
}
