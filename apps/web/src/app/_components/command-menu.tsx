import { searchableEntities } from "@cubby/schemas/entity-manifest";
import type { SearchableEntity } from "@cubby/schemas/search";
import {
  type ParsedShortcode,
  parseShortcode,
  type ShortcodeType,
} from "@cubby/shared";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  Activity,
  Equal,
  Search,
  Settings,
  Sparkles,
  Wrench,
  X,
} from "lucide-react";
import * as React from "react";

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
import { IconTile } from "~/components/ui/icon-tile";
import { Spinner } from "~/components/ui/spinner";
import {
  EntityIcon,
  entities,
  entityDetailParams,
  isBrowserRoutedEntity,
} from "~/entities/entities";
import { entityDetailFor } from "~/entities/entity-detail.functions";
import { useDebug } from "~/hooks/useDebug";
import { setFlag, useFlag } from "~/lib/flags";
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
import { getRecents, pushRecent } from "./command-menu/recents";
import { parseCommandSearchScope } from "./command-menu/search-scope";
import { useConversionAnswer } from "./command-menu/use-conversion-answer";
import { useGlobalSearch } from "./command-menu/use-global-search";
import { completeNavLeaves } from "./navigation/nav-items";
import type { NavItem } from "./navigation/nav-items";
import {
  entityTypeMap,
  getSearchMatchText,
  getSearchResultRoute,
  rememberSearchResult,
  type SearchHit,
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

const AskCubbyPanel = React.lazy(() =>
  import("./command-menu/ask-cubby").then((module) => ({
    default: module.AskCubbyPanel,
  })),
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

/** Narrow a shortcode's entity to the searchable subset `recents` stores. */
const isSearchableEntity = (
  entity: ShortcodeType,
): entity is ShortcodeType & SearchableEntity =>
  searchableEntities.some((candidate) => candidate === entity);

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
  const { isDevtoolsVisible, toggleDevtools } = useDebug();
  const perfOverlayOn = useFlag("perfOverlay");

  React.useEffect(() => {
    if (open) recordCommandMenuOpened();
  }, [open]);

  const { results, filteredActions, isLoading, isEmpty } = useGlobalSearch(
    search,
    searchScope ?? undefined,
  );
  const conversion = useConversionAnswer(searchScope ? "" : search);

  // Opt-in: the agent only runs when the user explicitly selects the Ask item.
  // Keyword/shortcode fast paths stay instant and untouched. Streams the
  // answer for a progressive "typing" reveal.
  const [answerMode, setAnswerMode] = React.useState(false);
  const [askQuery, setAskQuery] = React.useState<string | null>(null);
  const runAsk = (query: string) => {
    const trimmed = query.trim();
    if (trimmed.length === 0) return;
    setAskQuery(trimmed);
    setAnswerMode(true);
  };
  const exitAnswerMode = () => {
    setAnswerMode(false);
  };
  const { parsedShortcode, shortcodeName } = useShortcodePreview(
    search,
    searchScope,
  );

  const navigateToShortcode = (target: ParsedShortcode, name?: string) => {
    if (!isBrowserRoutedEntity(target.type)) return;
    // Recents needs a name, so it only gets an entry once the preview query has
    // landed — navigation itself never waits on it. Only the three legacy
    // shortcode preview queries above can contribute a name on this fast path;
    // ordinary text search covers every searchable entity.
    if (name && isSearchableEntity(target.type)) {
      pushRecent({
        entityType: target.type,
        id: target.shortcode,
        name,
      });
    }
    navigate({
      to: entities[target.type].routes.detail,
      params: entityDetailParams(target.shortcode),
    });
    setOpen(false);
  };

  const goToShortcode = () => {
    if (!parsedShortcode) return;
    navigateToShortcode(parsedShortcode, shortcodeName);
  };

  // The ⌘K hotkey is owned by the app shell (__root.tsx) so the shortcut works
  // before this (lazily loaded) menu has mounted. Don't register it here too,
  // or it would double-toggle once mounted.

  // Reset search and answer mode when dialog closes
  React.useEffect(() => {
    if (!open) {
      setSearch("");
      setSearchScope(null);
      setAnswerMode(false);
      setAskQuery(null);
    }
  }, [open]);

  // Recent jumps — read on open so the list reflects other tabs/sessions.
  const [recents, setRecents] = React.useState<ReturnType<typeof getRecents>>(
    [],
  );
  React.useEffect(() => {
    if (open) setRecents(getRecents());
  }, [open]);

  const goToEntity = (
    entityType: SearchableEntity,
    shortcode: string,
    name?: string,
  ) => {
    const entity = entities[entityTypeMap[entityType]];
    if (entity) {
      if (name) pushRecent({ entityType, id: shortcode, name });
      navigate({
        to: entity.routes.detail,
        params: entityDetailParams(shortcode),
      });
      setOpen(false);
    }
  };

  // An agent citation's shortcode is nullable: sources are scraped out of MCP
  // tool payloads, and not every projection carries one. No code means no
  // navigation — better a dead click than a uuid URL that 404s.
  const goToSource = (
    entityType: SearchableEntity,
    shortcode: string | null,
    name?: string,
  ) => {
    if (!shortcode) return;
    goToEntity(entityType, shortcode, name);
  };

  const goToSearchResult = (item: SearchHit) => {
    rememberSearchResult(item);
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
            {answerMode ? (
              <React.Suspense fallback={<CommandSearchSpinner />}>
                <AskCubbyPanel
                  query={askQuery ?? search}
                  showToolCalls={isDevtoolsVisible}
                  onBack={exitAnswerMode}
                  onSelectSource={goToSource}
                />
              </React.Suspense>
            ) : (
              <>
                {/* Inline unit conversion — "250 g flour in cups" */}
                {conversion && (
                  <CommandGroup heading="Conversion">
                    <CommandItem
                      value={`conversion-${search}`}
                      onSelect={() =>
                        goToEntity(
                          "ingredient",
                          conversion.ingredientShortcode,
                          conversion.ingredientName,
                        )
                      }
                      className="flex items-center gap-2"
                    >
                      <Equal className="size-4 shrink-0 text-primary" />
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
                  hasResults={hasResults}
                  isDevtoolsVisible={isDevtoolsVisible}
                  isLoading={isLoading}
                  navigate={navigate}
                  onClose={() => setOpen(false)}
                  onSelectResult={goToSearchResult}
                  results={results}
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

                {/* Agent is available after direct navigation results and actions. */}
                {hasSearch && !isLoading && (
                  <CommandGroup>
                    <CommandItem
                      value={`ask-cubby-${search}`}
                      onSelect={() => runAsk(search)}
                      className="flex items-center gap-2"
                    >
                      <Sparkles className="size-4 text-primary" />
                      <span className="truncate">
                        Ask Cubby:{" "}
                        <span className="text-muted-foreground">
                          "{search}"
                        </span>
                      </span>
                    </CommandItem>
                  </CommandGroup>
                )}

                <DefaultCommandMenu
                  filteredActions={filteredActions}
                  hasSearch={hasSearch}
                  isDevtoolsVisible={isDevtoolsVisible}
                  isLoading={isLoading}
                  navigate={navigate}
                  onClose={() => setOpen(false)}
                  onGoToEntity={goToEntity}
                  onGoToPage={goToPage}
                  perfOverlayOn={perfOverlayOn}
                  recents={recents}
                  searchScope={searchScope}
                  toggleDevtools={toggleDevtools}
                />
              </>
            )}
          </CommandList>
        </CommandDialog>
      )}
    </EntityPaletteActionsHost>
  );
}

function CommandSearchSpinner() {
  return (
    <Row align="center" justify="center" className="py-6">
      <Spinner className="text-muted-foreground" />
    </Row>
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
        scopeLabel
          ? `Search ${scopeLabel}…`
          : "Search, jump to a page, or ask Cubby…"
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
            <X data-icon="inline-end" />
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
  hasResults,
  isDevtoolsVisible,
  isLoading,
  navigate,
  onClose,
  onSelectResult,
  results,
  search,
  searchScope,
  scopeLabel,
}: {
  hasResults: boolean;
  isDevtoolsVisible: boolean;
  isLoading: boolean;
  navigate: CommandMenuNavigate;
  onClose: () => void;
  onSelectResult: (item: SearchHit) => void;
  results: SearchHit[] | undefined;
  search: string;
  searchScope: SearchableEntity | null;
  scopeLabel: string | null;
}) {
  if (!hasResults || isLoading || !results) return null;

  return (
    <div>
      <CommandGroup
        heading={scopeLabel ? `${scopeLabel} matches` : "Best matches"}
      >
        {results.map((item) => (
          <SearchResultItem
            key={`${item.entityType}-${item.id}`}
            isDevtoolsVisible={isDevtoolsVisible}
            item={item}
            onSelect={onSelectResult}
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
          <Search className="mr-2 size-4" />
          See all results for "{search}"
        </CommandItem>
      </CommandGroup>
    </div>
  );
}

function SearchResultItem({
  isDevtoolsVisible,
  item,
  onSelect,
}: {
  isDevtoolsVisible: boolean;
  item: SearchHit;
  onSelect: (item: SearchHit) => void;
}) {
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
  isDevtoolsVisible,
  isLoading,
  navigate,
  onClose,
  onGoToEntity,
  onGoToPage,
  perfOverlayOn,
  recents,
  searchScope,
  toggleDevtools,
}: {
  filteredActions: QuickAction[];
  hasSearch: boolean;
  isDevtoolsVisible: boolean;
  isLoading: boolean;
  navigate: CommandMenuNavigate;
  onClose: () => void;
  onGoToEntity: (
    entityType: SearchableEntity,
    shortcode: string,
    name?: string,
  ) => void;
  onGoToPage: GoToPage;
  perfOverlayOn: boolean;
  recents: ReturnType<typeof getRecents>;
  searchScope: SearchableEntity | null;
  toggleDevtools: () => void;
}) {
  if (hasSearch || searchScope || isLoading) return null;

  return (
    <>
      <RecentCommandItems recents={recents} onGoToEntity={onGoToEntity} />
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
          <Settings className="size-4" />
          <span>Settings</span>
        </CommandItem>
        <CommandItem
          onSelect={() => {
            setFlag("perfOverlay", !perfOverlayOn);
            onClose();
          }}
        >
          <Activity className="size-4" />
          <span>{perfOverlayOn ? "Hide" : "Show"} performance overlay</span>
        </CommandItem>
        <CommandItem
          onSelect={() => {
            toggleDevtools();
            onClose();
          }}
        >
          <Wrench className="size-4" />
          <span>{isDevtoolsVisible ? "Hide" : "Show"} Devtools</span>
        </CommandItem>
      </CommandGroup>
      <div className="px-2 pt-2 pb-1 text-xs text-muted-foreground">
        Tip: paste a shortcode (PRD-, LOC-, RCP-…) to jump instantly.
      </div>
    </>
  );
}

function RecentCommandItems({
  onGoToEntity,
  recents,
}: {
  onGoToEntity: (
    entityType: SearchableEntity,
    shortcode: string,
    name?: string,
  ) => void;
  recents: ReturnType<typeof getRecents>;
}) {
  if (recents.length === 0) return null;

  return (
    <CommandGroup heading="Jump back">
      {recents.map((recent) => (
        <CommandItem
          key={`recent-${recent.entityType}-${recent.id}`}
          value={`recent-${recent.id}`}
          onSelect={() =>
            onGoToEntity(recent.entityType, recent.id, recent.name)
          }
          className="flex items-center gap-2"
        >
          <IconTile
            size="sm"
            className={cn(
              "size-6 rounded",
              entities[entityTypeMap[recent.entityType]]?.color.bg ??
                "bg-muted/50",
              entities[entityTypeMap[recent.entityType]]?.color.text,
            )}
          >
            <EntityIcon
              entity={entityTypeMap[recent.entityType]}
              className="size-3.5"
            />
          </IconTile>
          <span className="truncate">{recent.name}</span>
        </CommandItem>
      ))}
    </CommandGroup>
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
