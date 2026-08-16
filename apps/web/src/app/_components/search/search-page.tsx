import type { SearchableEntity, SearchType } from "@cubby/schemas/search";
import { searchableEntities } from "@cubby/schemas/search";
import { useDebouncedValue } from "@tanstack/react-pacer";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { uniq } from "es-toolkit";
import { Search } from "lucide-react";
import { useEffect, useId, useMemo, useState } from "react";
import { MobileCard } from "~/components/entity/mobile-card";
import { MobileCardSkeletonList } from "~/components/feedback/mobile-card-skeleton";
import { Row, Stack } from "~/components/layout";
import { Badge } from "~/components/ui/badge";
import { Input } from "~/components/ui/input";
import { EntityIcon, entities } from "~/entities/entities";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import { useIsMobile } from "~/hooks/useMobile";
import { useTRPC } from "~/integrations/trpc/react";
import { cn } from "~/lib/utils";
import { getRecents, pushRecent } from "../command-menu/recents";
import { useEntityPreview } from "../hooks/useEntityPreview";
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

const filterOptions: Array<{ value: SearchType; label: string }> = [
  { value: "all", label: "All" },
  ...searchableEntities.map((entityType) => ({
    value: entityType as SearchType,
    label: entities[entityTypeMap[entityType]].label,
  })),
];

export function SearchPage({ query = "", type }: SearchPageProps) {
  const api = useTRPC();
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const { onRowClick, onRowHover, PreviewSheet } = useEntityPreview();
  const [draft, setDraft] = useState(query);
  const relatedHeadingId = useId();
  const [debouncedDraft] = useDebouncedValue(draft, { wait: 150 });
  const [relatedDraft] = useDebouncedValue(draft, { wait: 450 });
  const entityTypes = type === "all" ? undefined : [type as SearchableEntity];

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
    ...api.search.find.queryOptions({
      query: debouncedDraft,
      entityTypes,
      limit: 50,
    }),
    enabled: debouncedDraft.trim().length > 0,
    placeholderData: keepPreviousData,
  });
  const related = useQuery({
    ...api.search.related.queryOptions({
      query: relatedDraft,
      entityTypes,
      limit: 12,
    }),
    enabled: relatedDraft.trim().length > 0 && relatedDraft === draft,
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
  const [recents, setRecents] = useLocalStorage<string[]>(
    "cubby:recent-searches",
    [],
  );
  const hasQuery = draft.trim().length > 0;

  return (
    <Stack gap="md" className="container mx-auto p-1">
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
          className="pl-6"
          autoFocus
        />
      </div>
      {hasQuery ? (
        <Stack gap="md">
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
          {isMobile ? (
            <MobileSearchResults
              data={primary.data ?? []}
              isLoading={primary.isPending}
            />
          ) : (
            <SearchResults
              data={primary.data ?? []}
              isLoading={primary.isPending}
              error={primary.error}
              onPreview={onRowClick}
              onPrefetch={onRowHover}
            />
          )}
          {relatedResults.length > 0 && (
            <section
              aria-labelledby={relatedHeadingId}
              className="border-foreground border-t-2 pt-2"
            >
              <Row align="baseline" justify="between" className="mb-1">
                <h2
                  id={relatedHeadingId}
                  className="font-bold font-heading text-base"
                >
                  Related
                </h2>
                <span className="font-mono text-2xs text-muted-foreground uppercase">
                  Meaning-based matches
                </span>
              </Row>
              {isMobile ? (
                <MobileSearchResults data={relatedResults} isLoading={false} />
              ) : (
                <SearchResults
                  data={relatedResults}
                  isLoading={false}
                  error={null}
                  onPreview={onRowClick}
                  onPrefetch={onRowHover}
                />
              )}
            </section>
          )}
          {relatedDraft === draft &&
          !related.isPlaceholderData &&
          related.data?.status === "unavailable" &&
          primary.data?.length ? (
            <p className="text-muted-foreground text-xs">
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
          className="h-auto shrink-0 cursor-pointer px-2 py-1 text-xs"
          render={
            <button type="button" onClick={() => onChange(option.value)} />
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
  onPreview,
  onPrefetch,
}: {
  data: SearchHit[];
  isLoading: boolean;
  error: { message: string } | null;
  onPreview: <T extends Record<string, unknown>>(row: { original: T }) => void;
  onPrefetch: <T extends Record<string, unknown>>(row: { original: T }) => void;
}) {
  if (isLoading)
    return (
      <div className="py-8 text-center text-muted-foreground text-sm">
        Searching…
      </div>
    );
  if (error)
    return (
      <div role="status" className="py-8 text-center text-destructive text-sm">
        Search could not load. Try again.
      </div>
    );
  if (data.length === 0)
    return (
      <div className="py-8 text-center text-muted-foreground text-sm">
        No direct matches.
      </div>
    );
  return (
    <div className="border-border border-y">
      {data.map((item) => (
        <SearchRow
          key={`${item.entityType}:${item.id}`}
          item={item}
          onPreview={onPreview}
          onPrefetch={onPrefetch}
        />
      ))}
    </div>
  );
}

function SearchRow({
  item,
  onPreview,
  onPrefetch,
}: {
  item: SearchHit;
  onPreview: <T extends Record<string, unknown>>(row: { original: T }) => void;
  onPrefetch: <T extends Record<string, unknown>>(row: { original: T }) => void;
}) {
  return (
    <div className="group flex items-center gap-4 border-border border-b px-2 py-2 last:border-b-0 hover:bg-muted/45">
      <SearchResultMedia item={item} variant="list" />
      <div className="min-w-0 flex-1">
        <Link
          {...getSearchResultRoute(item)}
          onMouseEnter={() =>
            onPrefetch({
              original: item as SearchHit & Record<string, unknown>,
            })
          }
          onFocus={() =>
            onPrefetch({
              original: item as SearchHit & Record<string, unknown>,
            })
          }
          onClick={() => rememberSearchResult(item)}
          className="block truncate font-medium text-sm hover:text-primary"
        >
          {item.title}
        </Link>
        {item.subtitle && (
          <span className="block truncate text-muted-foreground text-xs">
            {item.subtitle}
          </span>
        )}
      </div>
      <button
        type="button"
        onClick={() =>
          onPreview({ original: item as SearchHit & Record<string, unknown> })
        }
        className="shrink-0 font-mono text-2xs text-muted-foreground uppercase hover:text-primary"
      >
        Preview
      </button>
      <div className="hidden max-w-44 shrink-0 text-right sm:block">
        <span className="block truncate font-mono text-2xs text-muted-foreground uppercase">
          {entities[entityTypeMap[item.entityType]].label}
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
}: {
  data: SearchHit[];
  isLoading: boolean;
}) {
  const navigate = useNavigate();
  if (isLoading) return <MobileCardSkeletonList count={6} />;
  if (data.length === 0)
    return (
      <div className="flex h-32 items-center justify-center text-muted-foreground text-sm">
        No direct matches.
      </div>
    );
  return (
    <div className="border-border border-y">
      {data.map((item) => (
        <MobileCard
          key={`${item.entityType}:${item.id}`}
          variant="row"
          title={item.title}
          subtitle={item.subtitle}
          imageSlot={<SearchResultMedia item={item} variant="mobile" />}
          rightValues={[
            entities[entityTypeMap[item.entityType]].label,
            getSearchMatchText(item),
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
          <span className="eyebrow px-1 font-medium">Jump back</span>
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
