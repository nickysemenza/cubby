import type {
  SearchableEntity,
  SearchComponentPlacement,
  SearchDestination,
  SearchInventoryPlacement,
  SearchResultGroup,
} from "@cubby/schemas/search";
import { type ParsedShortcode, parseShortcode } from "@cubby/shared";
import { CaretRightIcon } from "@phosphor-icons/react/dist/csr/CaretRight";
import { EqualsIcon } from "@phosphor-icons/react/dist/csr/Equals";
import { GearIcon } from "@phosphor-icons/react/dist/csr/Gear";
import { MagnifyingGlassIcon } from "@phosphor-icons/react/dist/csr/MagnifyingGlass";
import { MapPinIcon } from "@phosphor-icons/react/dist/csr/MapPin";
import { XIcon } from "@phosphor-icons/react/dist/csr/X";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import * as React from "react";

import { ErrorDisplay } from "~/components/feedback/error-display";
import { Row } from "~/components/layout";
import { Badge } from "~/components/ui/badge";
import {
  CommandDialog,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "~/components/ui/command";
import { Spinner } from "~/components/ui/spinner";
import {
  EntityIcon,
  entities,
  entityDetailParams,
  isBrowserRoutedEntity,
} from "~/entities/entities";
import { entityDetailFor } from "~/entities/entity-detail.functions";
import { enumFieldLabel } from "~/entities/enum-field-display";
import { useDebug } from "~/hooks/useDebug";
import { cn } from "~/lib/utils";

import { recordCommandMenuOpened } from "./command-menu-loader";
import {
  EntityPaletteActionGroup,
  EntityPaletteActionsHost,
  type PaletteAction,
} from "./command-menu/entity-palette-actions";
import { parsePastedShortcode } from "./command-menu/pasted-shortcode";
import { quickActions } from "./command-menu/quick-actions";
import type { QuickAction } from "./command-menu/quick-actions";
import { parseCommandSearchScope } from "./command-menu/search-scope";
import { useConversionAnswer } from "./command-menu/use-conversion-answer";
import { useGlobalSearch } from "./command-menu/use-global-search";
import { completeNavLeaves } from "./navigation/nav-items";
import type { NavItem } from "./navigation/nav-items";
import {
  entityTypeMap,
  getSearchMatchText,
  getSearchResultRoute,
  SearchResultMedia,
} from "./search/search-utils";

/**
 * "Go to" destinations — every authed navbar leaf, so the palette covers the
 * whole navbar and stays in sync with it. Drops leaves already surfaced by
 * Quick Actions (Scan UPC, Labels, Problems) or the dedicated Settings group,
 * so nothing appears twice in the browse state.
 */
const quickActionPaths = new Set(quickActions.map((action) => action.path));
type RoutedNavItem = NavItem & { to: string };
const hasRoutedPath = (leaf: NavItem): leaf is RoutedNavItem =>
  typeof leaf.to === "string";
const goToLeaves = completeNavLeaves.filter(
  (leaf): leaf is RoutedNavItem =>
    hasRoutedPath(leaf) &&
    leaf.to !== "/settings" &&
    !quickActionPaths.has(leaf.to),
);

interface GlobalCommandMenuProps {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

type NavigationSearch = NonNullable<NavItem["search"]>;
type GoToPage = (
  path: string,
  searchParams?: NavigationSearch | { create: true },
) => void;
type CommandMenuNavigate = ReturnType<typeof useNavigate>;

/**
 * The preview is deliberately limited to the legacy shortcode routes. A
 * scoped query is literal search text, while an exact pasted shortcode still
 * takes the direct navigation path below.
 */
function useShortcodePreview(
  search: string,
  searchScope: SearchableEntity | null,
) {
  const parsedShortcode = searchScope ? null : parseShortcode(search);
  const locationQuery = useQuery({
    ...entityDetailFor("location").queryOptions(
      parsedShortcode?.type === "location"
        ? parsedShortcode.shortcode
        : "LOC-2222",
    ),
    enabled: parsedShortcode?.type === "location",
  });
  const productQuery = useQuery({
    ...entityDetailFor("product").queryOptions(
      parsedShortcode?.type === "product"
        ? parsedShortcode.shortcode
        : "PRD-2222",
    ),
    enabled: parsedShortcode?.type === "product",
  });
  const recipeQuery = useQuery({
    ...entityDetailFor("recipe").queryOptions(
      parsedShortcode?.type === "recipe"
        ? parsedShortcode.shortcode
        : "RCP-2222",
    ),
    enabled: parsedShortcode?.type === "recipe",
  });
  const shortcodeName =
    parsedShortcode?.type === "location"
      ? locationQuery.data?.name
      : parsedShortcode?.type === "product"
        ? productQuery.data?.name
        : parsedShortcode?.type === "recipe"
          ? recipeQuery.data?.name
          : undefined;

  return { parsedShortcode, shortcodeName };
}

export function GlobalCommandMenu({
  open: externalOpen,
  onOpenChange: externalOnOpenChange,
}: GlobalCommandMenuProps = {}) {
  const [internalOpen, setInternalOpen] = React.useState(false);

  // Use external control if provided, otherwise use internal state
  const open = externalOpen ?? internalOpen;
  const setOpen = externalOnOpenChange ?? setInternalOpen;
  const [search, setSearch] = React.useState("");
  const [searchScope, setSearchScope] = React.useState<SearchableEntity | null>(
    null,
  );
  const searchInputRef = React.useRef<HTMLInputElement>(null);
  const navigate = useNavigate();
  const { isDevtoolsVisible } = useDebug();

  React.useEffect(() => {
    if (open) recordCommandMenuOpened();
  }, [open]);

  const { results, filteredActions, isLoading, isEmpty, error, retry } =
    useGlobalSearch(search, searchScope ?? undefined);
  const conversion = useConversionAnswer(searchScope ? "" : search);

  const { parsedShortcode, shortcodeName } = useShortcodePreview(
    search,
    searchScope,
  );

  const navigateToShortcode = (target: ParsedShortcode) => {
    if (!isBrowserRoutedEntity(target.type)) return;
    navigate({
      to: entities[target.type].routes.detail,
      params: entityDetailParams(target.shortcode),
    });
    setOpen(false);
  };

  const goToShortcode = () => {
    if (!parsedShortcode) return;
    navigateToShortcode(parsedShortcode);
  };

  // The ⌘K hotkey is owned by the app shell (__root.tsx) so the shortcut works
  // before this (lazily loaded) menu has mounted. Don't register it here too,
  // or it would double-toggle once mounted.

  // Reset search when dialog closes
  React.useEffect(() => {
    if (!open) {
      setSearch("");
      setSearchScope(null);
    }
  }, [open]);

  const goToEntity = (entityType: SearchableEntity, shortcode: string) => {
    const entity = entities[entityTypeMap[entityType]];
    if (entity) {
      navigate({
        to: entity.routes.detail,
        params: entityDetailParams(shortcode),
      });
      setOpen(false);
    }
  };

  const goToSearchResult = (item: SearchDestination) => {
    navigate(getSearchResultRoute(item));
    setOpen(false);
  };

  // `search` carries an action's deep-link params (e.g. the tracker quick
  // captures' `{ create: true }`) — a query string on `path` would be treated
  // as part of the pathname.
  const goToPage = (
    path: string,
    searchParams?: NavigationSearch | { create: true },
  ) => {
    navigate({
      to: path,
      search: searchParams ? { ...searchParams } : undefined,
    });
    setOpen(false);
  };

  // Determine what to show based on search state
  const hasSearch = search.length > 0;
  const hasResults = (results?.length ?? 0) > 0;
  const scopeLabel = searchScope
    ? entities[entityTypeMap[searchScope]].pluralLabel
    : null;

  const handleSearchChange = (value: string) => {
    if (!searchScope) {
      const parsed = parseCommandSearchScope(value);
      if (parsed.entityType) {
        setSearchScope(parsed.entityType);
        setSearch(parsed.query);
        return;
      }
    }
    setSearch(value);
  };

  const handleSearchPaste = (event: React.ClipboardEvent<HTMLInputElement>) => {
    const target = parsePastedShortcode({
      currentValue: event.currentTarget.value,
      pastedText: event.clipboardData.getData("text/plain"),
      selectionStart: event.currentTarget.selectionStart,
      selectionEnd: event.currentTarget.selectionEnd,
    });
    if (!target || !isBrowserRoutedEntity(target.type)) return;

    event.preventDefault();
    navigateToShortcode(target);
  };

  const clearSearchScope = () => {
    setSearchScope(null);
    searchInputRef.current?.focus();
  };

  return (
    <EntityPaletteActionsHost
      entity={
        parsedShortcode && isBrowserRoutedEntity(parsedShortcode.type)
          ? parsedShortcode.type
          : null
      }
    >
      {(entityActions) => (
        <CommandDialog
          open={open}
          onOpenChange={setOpen}
          shouldFilter={false}
          className="sm:max-w-2xl"
        >
          <CommandMenuInput
            clearSearchScope={clearSearchScope}
            onPaste={handleSearchPaste}
            onSearchChange={handleSearchChange}
            search={search}
            searchInputRef={searchInputRef}
            searchScope={searchScope}
            scopeLabel={scopeLabel}
          />
          <CommandList className="max-h-96">
            <>
              {/* Inline unit conversion — "250 g flour in cups" */}
              {conversion && (
                <CommandGroup heading="Conversion">
                  <CommandItem
                    value={`conversion-${search}`}
                    onSelect={() =>
                      goToEntity("ingredient", conversion.ingredientShortcode)
                    }
                    className="flex items-center gap-2"
                  >
                    <EqualsIcon className="size-4 shrink-0 text-primary" />
                    <span className="truncate font-mono text-sm font-semibold tabular-nums">
                      {conversion.input} {conversion.ingredientName} ={" "}
                      {conversion.result}
                    </span>
                    {conversion.cost && (
                      <span className="ml-auto shrink-0 font-mono text-xs text-muted-foreground tabular-nums">
                        ≈ {conversion.cost}
                      </span>
                    )}
                  </CommandItem>
                </CommandGroup>
              )}

              {/* Loading state — first results only; refetches keep the
                previous list rendered (dimmed) instead of blanking it */}
              {isLoading && (
                <Row align="center" justify="center" className="py-6">
                  <Spinner className="text-muted-foreground" />
                </Row>
              )}

              {/* Empty state */}
              {isEmpty && !isLoading && !parsedShortcode && (
                <output className="block py-6 text-center text-xs/relaxed text-muted-foreground">
                  {scopeLabel
                    ? `No ${scopeLabel.toLocaleLowerCase()} matched “${search}”.`
                    : "Nothing matched — try another word."}
                </output>
              )}

              {searchScope && !hasSearch && (
                <output className="block py-6 text-center text-xs/relaxed text-muted-foreground">
                  Type to search {scopeLabel}.
                </output>
              )}

              <ShortcodeCommandItems
                actions={entityActions}
                name={shortcodeName}
                onClose={() => setOpen(false)}
                onGoToShortcode={goToShortcode}
                parsedShortcode={parsedShortcode}
              />

              <SearchResults
                error={error}
                hasResults={hasResults}
                isDevtoolsVisible={isDevtoolsVisible}
                isLoading={isLoading}
                navigate={navigate}
                onClose={() => setOpen(false)}
                onSelectResult={goToSearchResult}
                results={results}
                retry={retry}
                search={search}
                searchScope={searchScope}
                scopeLabel={scopeLabel}
              />

              <MatchingQuickActions
                actions={filteredActions}
                hasResults={hasResults}
                hasSearch={hasSearch}
                isLoading={isLoading}
                onGoToPage={goToPage}
              />

              <DefaultCommandMenu
                filteredActions={filteredActions}
                hasSearch={hasSearch}
                isLoading={isLoading}
                navigate={navigate}
                onClose={() => setOpen(false)}
                onGoToPage={goToPage}
                searchScope={searchScope}
              />
            </>
          </CommandList>
        </CommandDialog>
      )}
    </EntityPaletteActionsHost>
  );
}

function CommandMenuInput({
  clearSearchScope,
  onPaste,
  onSearchChange,
  search,
  searchInputRef,
  searchScope,
  scopeLabel,
}: {
  clearSearchScope: () => void;
  onPaste: (event: React.ClipboardEvent<HTMLInputElement>) => void;
  onSearchChange: (value: string) => void;
  search: string;
  searchInputRef: React.RefObject<HTMLInputElement | null>;
  searchScope: SearchableEntity | null;
  scopeLabel: string | null;
}) {
  const hasScope = searchScope !== null && scopeLabel !== null;

  return (
    <CommandInput
      ref={searchInputRef}
      placeholder={
        scopeLabel ? `Search ${scopeLabel}…` : "Search or jump to a page…"
      }
      value={search}
      onValueChange={onSearchChange}
      onPaste={onPaste}
      onKeyDown={(event) => {
        if (event.key !== "Backspace" || search.length > 0 || !searchScope) {
          return;
        }
        event.preventDefault();
        clearSearchScope();
      }}
      startAdornment={
        hasScope ? (
          <Badge
            variant="secondary"
            render={
              <button
                type="button"
                aria-label={`Clear ${scopeLabel} scope`}
                onClick={clearSearchScope}
              />
            }
          >
            {scopeLabel}
            <XIcon data-icon="inline-end" />
          </Badge>
        ) : undefined
      }
    />
  );
}

function ShortcodeCommandItems({
  actions,
  name,
  onClose,
  onGoToShortcode,
  parsedShortcode,
}: {
  actions: PaletteAction[];
  name?: string | null;
  onClose: () => void;
  onGoToShortcode: () => void;
  parsedShortcode: ParsedShortcode | null;
}) {
  if (!parsedShortcode || !isBrowserRoutedEntity(parsedShortcode.type)) {
    return null;
  }

  return (
    <>
      <CommandGroup heading="Go to">
        <CommandItem
          onSelect={onGoToShortcode}
          className="flex items-center gap-2"
        >
          <EntityIcon entity={parsedShortcode.type} className="size-4" />
          <span>Go to {name ?? entities[parsedShortcode.type].label}</span>
          <span className="ml-auto font-mono text-xs text-muted-foreground">
            {parsedShortcode.shortcode}
          </span>
        </CommandItem>
      </CommandGroup>
      <EntityPaletteActionGroup
        actions={actions}
        shortcode={parsedShortcode.shortcode}
        name={name}
        onRun={onClose}
      />
    </>
  );
}

function MatchingQuickActions({
  actions,
  hasResults,
  hasSearch,
  isLoading,
  onGoToPage,
}: {
  actions: QuickAction[];
  hasResults: boolean;
  hasSearch: boolean;
  isLoading: boolean;
  onGoToPage: GoToPage;
}) {
  if (!hasSearch || actions.length === 0 || isLoading) return null;

  return (
    <>
      {hasResults && <CommandSeparator />}
      <QuickActionItems actions={actions} onGoToPage={onGoToPage} />
    </>
  );
}

function SearchResults({
  error,
  hasResults,
  isDevtoolsVisible,
  isLoading,
  navigate,
  onClose,
  onSelectResult,
  results,
  retry,
  search,
  searchScope,
  scopeLabel,
}: {
  error: unknown;
  hasResults: boolean;
  isDevtoolsVisible: boolean;
  isLoading: boolean;
  navigate: CommandMenuNavigate;
  onClose: () => void;
  onSelectResult: (item: SearchDestination) => void;
  results: SearchResultGroup[] | undefined;
  retry: () => void;
  search: string;
  searchScope: SearchableEntity | null;
  scopeLabel: string | null;
}) {
  const [expandedKeys, setExpandedKeys] = React.useState<Set<string>>(
    () => new Set(),
  );
  React.useEffect(() => setExpandedKeys(new Set()), [search]);

  if (error && !isLoading) {
    return (
      <CommandGroup heading="Search unavailable">
        <div className="px-2 py-1.5">
          <ErrorDisplay error={error} title="search results" onRetry={retry} />
        </div>
      </CommandGroup>
    );
  }
  if (!hasResults || isLoading || !results) return null;

  const toggleExpanded = (key: string, next?: boolean) => {
    setExpandedKeys((current) => {
      const updated = new Set(current);
      const shouldExpand = next ?? !updated.has(key);
      if (shouldExpand) updated.add(key);
      else updated.delete(key);
      return updated;
    });
  };

  return (
    <div>
      <CommandGroup
        heading={scopeLabel ? `${scopeLabel} matches` : "Best matches"}
      >
        {results.map((group) => (
          <SearchGroupItem
            key={group.key}
            expanded={expandedKeys.has(group.key)}
            group={group}
            isDevtoolsVisible={isDevtoolsVisible}
            onSeeAll={() => {
              navigate({
                to: "/search",
                search: { q: search, type: searchScope ?? undefined },
              });
              onClose();
            }}
            onSelect={onSelectResult}
            onToggle={(next) => toggleExpanded(group.key, next)}
          />
        ))}
      </CommandGroup>
      <CommandGroup>
        <CommandItem
          onSelect={() => {
            navigate({
              to: "/search",
              search: { q: search, type: searchScope ?? undefined },
            });
            onClose();
          }}
          className="justify-center text-muted-foreground"
        >
          <MagnifyingGlassIcon className="mr-2 size-4" />
          See all results for "{search}"
        </CommandItem>
      </CommandGroup>
    </div>
  );
}

const formatPlacementAmount = (placement: SearchInventoryPlacement) => {
  const { value, upperValue, unit } = placement.amount;
  return `${value}${upperValue === undefined ? "" : `–${upperValue}`} ${unit}`;
};

const placementDestination = (
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

const componentPlacementDestination = (
  componentPlacement: SearchComponentPlacement,
): SearchDestination => ({
  ...componentPlacement.component,
  id: componentPlacement.placement.id,
  entityType: "inventory",
  subtitle: componentPlacement.placement.locationPath,
});

function productGroupSummary(
  group: Extract<SearchResultGroup, { kind: "product" }>,
) {
  const placementCount = group.placements.length;
  const componentPlacementCount = group.componentPlacements.length;
  const paths = [
    ...group.placements.map((placement) => placement.locationPath),
    ...group.componentPlacements.map(({ placement }) => placement.locationPath),
  ];
  const parts = [];
  if (placementCount > 0) {
    parts.push(
      `${placementCount} ${componentPlacementCount > 0 ? "direct " : ""}${placementCount === 1 ? "placement" : "placements"}`,
    );
  } else if (componentPlacementCount === 0) {
    parts.push("0 placements");
  }
  if (componentPlacementCount > 0) {
    parts.push("Kit contents placed");
  }
  const distinctPaths = [...new Set(paths)].slice(0, 2);
  if (distinctPaths.length > 0) parts.push(distinctPaths.join(", "));
  if (group.matchedActivity.length > 0) {
    const count = group.matchedActivity.length;
    parts.push(`${count} matching ${count === 1 ? "record" : "records"}`);
  }
  return parts.join(" · ");
}

export function SearchGroupItem({
  expanded,
  group,
  isDevtoolsVisible,
  onSeeAll,
  onSelect,
  onToggle,
}: {
  expanded: boolean;
  group: SearchResultGroup;
  isDevtoolsVisible: boolean;
  onSeeAll: () => void;
  onSelect: (item: SearchDestination) => void;
  onToggle: (expanded?: boolean) => void;
}) {
  if (group.kind === "entity") {
    return (
      <SearchEntityResultItem
        group={group}
        isDevtoolsVisible={isDevtoolsVisible}
        onSelect={onSelect}
      />
    );
  }

  const matchText = getSearchMatchText(group.bestMatch);
  const hasChildren =
    group.placements.length > 0 ||
    group.componentPlacements.length > 0 ||
    group.matchedActivity.length > 0;
  const placements = group.placements.slice(0, 2);
  const componentPlacements = group.componentPlacements.slice(
    0,
    2 - placements.length,
  );
  const activity = group.matchedActivity.slice(0, 2);
  const hiddenCount =
    group.placements.length -
    placements.length +
    (group.componentPlacements.length - componentPlacements.length) +
    (group.matchedActivity.length - activity.length);
  const regionId = `command-search-${group.primary.id}`;

  return (
    <>
      <div className="flex items-stretch">
        <CommandItem
          value={`product-${group.primary.id}`}
          onSelect={() => onSelect(group.primary)}
          onKeyDown={(event) => {
            if (!hasChildren) return;
            if (event.key === "ArrowRight") {
              event.preventDefault();
              onToggle(true);
            } else if (event.key === "ArrowLeft") {
              event.preventDefault();
              onToggle(false);
            }
          }}
          aria-expanded={hasChildren ? expanded : undefined}
          aria-controls={hasChildren ? regionId : undefined}
          className="min-w-0 flex-1 items-center gap-2"
        >
          <SearchResultMedia item={group.primary} />
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm">{group.primary.title}</div>
            <div className="truncate text-xs text-muted-foreground">
              {[group.primary.subtitle, productGroupSummary(group)]
                .filter(Boolean)
                .join(" · ")}
            </div>
            {isDevtoolsVisible && matchText && (
              <div
                className="truncate text-2xs text-muted-foreground"
                title={group.bestMatch.matchReason}
              >
                {matchText}
              </div>
            )}
          </div>
          <div className="max-w-28 shrink-0 self-start pt-1 text-right">
            <span className="block truncate font-mono text-2xs tracking-wider text-slate uppercase">
              Product
            </span>
            <span className="block truncate font-mono text-2xs text-muted-foreground tabular-nums">
              {group.primary.id}
            </span>
          </div>
        </CommandItem>
        {hasChildren && (
          <button
            type="button"
            aria-label={`${expanded ? "Collapse" : "Expand"} ${group.primary.title} placements and matching records`}
            aria-expanded={expanded}
            aria-controls={regionId}
            onClick={() => onToggle()}
            className="flex size-11 shrink-0 items-center justify-center text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-primary sm:size-9"
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
        <fieldset
          id={regionId}
          aria-label={`${group.primary.title} placements and matching records`}
          className="border-y border-border bg-muted/25 py-1"
        >
          {placements.map((placement) => {
            const destination = placementDestination(group, placement);
            return (
              <CommandItem
                key={placement.id}
                value={`placement-${placement.id}`}
                onSelect={() => onSelect(destination)}
                className="min-h-11 gap-2 pl-8 sm:min-h-9"
              >
                <MapPinIcon className="size-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-xs font-medium">
                    {placement.locationPath}
                  </div>
                  <div className="truncate text-2xs text-muted-foreground">
                    {formatPlacementAmount(placement)} ·{" "}
                    {enumFieldLabel(
                      "inventory",
                      "placement",
                      placement.placement,
                    )}
                  </div>
                </div>
                <span className="font-mono text-2xs text-muted-foreground tabular-nums">
                  {placement.id}
                </span>
              </CommandItem>
            );
          })}
          {componentPlacements.map((componentPlacement) => {
            const destination =
              componentPlacementDestination(componentPlacement);
            return (
              <CommandItem
                key={`${componentPlacement.component.id}-${componentPlacement.placement.id}`}
                value={`component-placement-${componentPlacement.placement.id}`}
                onSelect={() => onSelect(destination)}
                className="min-h-11 gap-2 pl-8 sm:min-h-9"
              >
                <SearchResultMedia item={componentPlacement.component} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-xs font-medium">
                    {componentPlacement.component.title}
                  </div>
                  <div className="truncate text-2xs text-muted-foreground">
                    {componentPlacement.componentQuantity > 1
                      ? `${componentPlacement.componentQuantity}× kit content`
                      : "Kit content"}{" "}
                    · {componentPlacement.placement.locationPath} ·{" "}
                    {formatPlacementAmount(componentPlacement.placement)} ·{" "}
                    {enumFieldLabel(
                      "inventory",
                      "placement",
                      componentPlacement.placement.placement,
                    )}
                  </div>
                </div>
                <span className="font-mono text-2xs text-muted-foreground tabular-nums">
                  {componentPlacement.placement.id}
                </span>
              </CommandItem>
            );
          })}
          {activity.map((item) => (
            <CommandItem
              key={`${item.entityType}-${item.id}`}
              value={`activity-${item.entityType}-${item.id}`}
              onSelect={() => onSelect(item)}
              className="min-h-11 gap-2 pl-8 sm:min-h-9"
            >
              <SearchResultMedia item={item} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-xs font-medium">{item.title}</div>
                <div className="truncate text-2xs text-muted-foreground">
                  {entities[entityTypeMap[item.entityType]].label} · {item.id} ·
                  Linked to {group.primary.title}
                </div>
              </div>
            </CommandItem>
          ))}
          {hiddenCount > 0 && (
            <CommandItem
              value={`more-${group.primary.id}`}
              onSelect={onSeeAll}
              className="min-h-11 justify-center text-xs text-muted-foreground sm:min-h-9"
            >
              <MagnifyingGlassIcon className="mr-2 size-4" />
              See {hiddenCount} more in full search
            </CommandItem>
          )}
        </fieldset>
      )}
    </>
  );
}

function SearchEntityResultItem({
  group,
  isDevtoolsVisible,
  onSelect,
}: {
  group: Extract<SearchResultGroup, { kind: "entity" }>;
  isDevtoolsVisible: boolean;
  onSelect: (item: SearchDestination) => void;
}) {
  const item = group.primary;
  const matchText = getSearchMatchText(item);

  return (
    <CommandItem
      value={`${item.entityType}-${item.id}`}
      onSelect={() => onSelect(item)}
      className="flex items-center gap-2"
    >
      <SearchResultMedia item={item} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm">{item.title}</div>
        {item.subtitle && (
          <div className="truncate text-xs text-muted-foreground">
            {item.subtitle}
          </div>
        )}
        {group.linkedProduct && (
          <div className="truncate text-2xs text-muted-foreground">
            Linked to {group.linkedProduct.title}
          </div>
        )}
        {isDevtoolsVisible && matchText && (
          <div
            className="truncate text-2xs text-muted-foreground"
            title={item.matchReason}
          >
            {matchText}
          </div>
        )}
      </div>
      <div className="max-w-28 shrink-0 self-start pt-1 text-right">
        <span className="block truncate font-mono text-2xs tracking-wider text-slate uppercase">
          {entities[entityTypeMap[item.entityType]].label}
        </span>
        <span className="block truncate font-mono text-2xs text-muted-foreground tabular-nums">
          {item.id}
        </span>
      </div>
    </CommandItem>
  );
}

function DefaultCommandMenu({
  filteredActions,
  hasSearch,
  isLoading,
  navigate,
  onClose,
  onGoToPage,
  searchScope,
}: {
  filteredActions: QuickAction[];
  hasSearch: boolean;
  isLoading: boolean;
  navigate: CommandMenuNavigate;
  onClose: () => void;
  onGoToPage: GoToPage;
  searchScope: SearchableEntity | null;
}) {
  if (hasSearch || searchScope || isLoading) return null;

  return (
    <>
      <QuickActionItems actions={filteredActions} onGoToPage={onGoToPage} />
      <CommandSeparator />
      <CommandGroup heading="Go to">
        {goToLeaves.map((leaf) => (
          <CommandItem key={leaf.to} onSelect={() => onGoToPage(leaf.to)}>
            <leaf.icon className="size-4" />
            <span>{leaf.label}</span>
          </CommandItem>
        ))}
      </CommandGroup>
      <CommandSeparator />
      <CommandGroup heading="Settings">
        <CommandItem
          onSelect={() => {
            navigate({ to: "/settings" });
            onClose();
          }}
        >
          <GearIcon className="size-4" />
          <span>Settings</span>
        </CommandItem>
      </CommandGroup>
      <div className="px-2 pt-2 pb-1 text-xs text-muted-foreground">
        Tip: paste a shortcode (PRD-, LOC-, RCP-…) to jump instantly.
      </div>
    </>
  );
}

function QuickActionItems({
  actions,
  onGoToPage,
}: {
  actions: QuickAction[];
  onGoToPage: GoToPage;
}) {
  return (
    <CommandGroup heading="Quick Actions">
      {actions.map((action) => (
        <CommandItem
          key={action.id}
          onSelect={() => onGoToPage(action.path, action.search)}
        >
          <action.icon className="size-4" />
          <span>{action.name}</span>
        </CommandItem>
      ))}
    </CommandGroup>
  );
}
