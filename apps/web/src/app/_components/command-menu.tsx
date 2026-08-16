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
import { EntityIcon, entities, entityDetailParams } from "~/entities/entities";
import { useDebug } from "~/hooks/useDebug";
import { useTRPC } from "~/integrations/trpc/react";
import { setFlag, useFlag } from "~/lib/flags";
import { cn } from "~/lib/utils";
import { parsePastedShortcode } from "./command-menu/pasted-shortcode";
import { quickActions } from "./command-menu/quick-actions";
import { getRecents, pushRecent } from "./command-menu/recents";
import { parseCommandSearchScope } from "./command-menu/search-scope";
import { useConversionAnswer } from "./command-menu/use-conversion-answer";
import { useGlobalSearch } from "./command-menu/use-global-search";
import { recordCommandMenuOpened } from "./command-menu-loader";
import { desktopLeaves } from "./navigation/nav-items";
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
const goToLeaves = desktopLeaves.filter(
  (leaf) => leaf.to !== "/settings" && !quickActionPaths.has(leaf.to as string),
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

/** Narrow a shortcode's entity to the searchable subset `recents` stores. */
const isSearchableEntity = (
  entity: ShortcodeType,
): entity is ShortcodeType & SearchableEntity =>
  (searchableEntities as readonly string[]).includes(entity);

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

  const trpc = useTRPC();

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
  // Shortcode detection and lookup. The queries exist only to PREVIEW the name
  // in the menu — navigation needs no lookup at all, since the prefix already
  // names the entity and the code is the URL. They key on the canonical form so
  // a typed legacy code (`P-4K7M`) previews as well as a current one.
  //
  // Suppressed under a scope: `search` there is a query string being typed
  // INTO that entity's list, not a candidate shortcode, so a partial match
  // (e.g. scoped to product, typing "PRD-4K7") must stay literal search text
  // rather than race toward a preview/navigation. `handleSearchPaste` below
  // deliberately does NOT apply this suppression — a paste is only recognized
  // when it resolves to a complete, exact shortcode (see
  // `parsePastedShortcode`'s doc comment), which is a high-confidence,
  // one-shot user action distinct from incremental typing, so it jumps
  // regardless of scope.
  const parsedShortcode = searchScope ? null : parseShortcode(search);
  const canonicalShortcode = parsedShortcode?.shortcode ?? "";
  const locationQuery = useQuery({
    ...trpc.location.getByShortcode.queryOptions({
      shortcode: canonicalShortcode,
    }),
    enabled: parsedShortcode?.type === "location",
  });
  const productQuery = useQuery({
    ...trpc.product.getByShortcode.queryOptions({
      shortcode: canonicalShortcode,
    }),
    enabled: parsedShortcode?.type === "product",
  });
  const recipeQuery = useQuery({
    ...trpc.recipe.getByShortcode.queryOptions({
      shortcode: canonicalShortcode,
    }),
    enabled: parsedShortcode?.type === "recipe",
  });

  const shortcodeResult =
    parsedShortcode?.type === "location"
      ? locationQuery.data
      : parsedShortcode?.type === "product"
        ? productQuery.data
        : parsedShortcode?.type === "recipe"
          ? recipeQuery.data
          : null;

  const navigateToShortcode = (target: ParsedShortcode, name?: string) => {
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
    navigateToShortcode(parsedShortcode, shortcodeResult?.name);
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
  const goToPage = (path: string, searchParams?: Record<string, unknown>) => {
    navigate({ to: path, search: searchParams });
    setOpen(false);
  };

  // Determine what to show based on search state
  const hasSearch = search.length > 0;
  const hasResults = results && results.length > 0;
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
    if (!target) return;

    event.preventDefault();
    navigateToShortcode(target);
  };

  const clearSearchScope = () => {
    setSearchScope(null);
    searchInputRef.current?.focus();
  };

  return (
    <CommandDialog
      open={open}
      onOpenChange={setOpen}
      shouldFilter={false}
      className="sm:max-w-2xl"
    >
      <CommandInput
        ref={searchInputRef}
        placeholder={
          scopeLabel
            ? `Search ${scopeLabel}…`
            : "Search, jump to a page, or ask Cubby…"
        }
        value={search}
        onValueChange={handleSearchChange}
        onPaste={handleSearchPaste}
        onKeyDown={(event) => {
          if (event.key === "Backspace" && search.length === 0 && searchScope) {
            event.preventDefault();
            clearSearchScope();
          }
        }}
        startAdornment={
          searchScope && scopeLabel ? (
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
                  <span className="truncate font-mono font-semibold text-sm tabular-nums">
                    {conversion.input} {conversion.ingredientName} ={" "}
                    {conversion.result}
                  </span>
                  {conversion.cost && (
                    <span className="ml-auto shrink-0 font-mono text-muted-foreground text-xs tabular-nums">
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
              <div
                role="status"
                className="py-6 text-center text-muted-foreground text-xs/relaxed"
              >
                {scopeLabel
                  ? `No ${scopeLabel.toLocaleLowerCase()} matched “${search}”.`
                  : "Nothing matched — try another word."}
              </div>
            )}

            {searchScope && !hasSearch && (
              <div
                role="status"
                className="py-6 text-center text-muted-foreground text-xs/relaxed"
              >
                Type to search {scopeLabel}.
              </div>
            )}

            {/* A structurally valid shortcode can always navigate directly: the
                prefix identifies its route, whose loader owns the live-row 404. */}
            {parsedShortcode && (
              <CommandGroup heading="Go to">
                <CommandItem
                  onSelect={goToShortcode}
                  className="flex items-center gap-2"
                >
                  <EntityIcon
                    entity={parsedShortcode.type}
                    className="size-4"
                  />
                  <span>
                    Go to{" "}
                    {shortcodeResult?.name ??
                      entities[parsedShortcode.type].label}
                  </span>
                  <span className="ml-auto font-mono text-muted-foreground text-xs">
                    {parsedShortcode.shortcode}
                  </span>
                </CommandItem>
              </CommandGroup>
            )}

            {/* Search results are lexical and stable: Cmd-K is a jump surface. */}
            {hasResults && !isLoading && (
              <div>
                <CommandGroup
                  heading={
                    scopeLabel ? `${scopeLabel} matches` : "Best matches"
                  }
                >
                  {results.map((item) => {
                    const matchText = getSearchMatchText(item);

                    return (
                      <CommandItem
                        key={`${item.entityType}-${item.id}`}
                        onSelect={() => goToSearchResult(item)}
                        className="flex items-center gap-2"
                      >
                        <SearchResultMedia item={item} />
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm">{item.title}</div>
                          {item.subtitle && (
                            <div className="truncate text-muted-foreground text-xs">
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
                        <span className="shrink-0 self-start pt-1 font-mono text-2xs text-slate uppercase tracking-wider">
                          {item.entityType}
                        </span>
                      </CommandItem>
                    );
                  })}
                </CommandGroup>
                <CommandGroup>
                  <CommandItem
                    onSelect={() => {
                      navigate({
                        to: "/search",
                        search: {
                          q: search,
                          type: searchScope ?? undefined,
                        },
                      });
                      setOpen(false);
                    }}
                    className="justify-center text-muted-foreground"
                  >
                    <Search className="mr-2 size-4" />
                    See all results for "{search}"
                  </CommandItem>
                </CommandGroup>
              </div>
            )}

            {/* Quick Actions - show when searching and matching */}
            {hasSearch && filteredActions.length > 0 && !isLoading && (
              <>
                {hasResults && <CommandSeparator />}
                <CommandGroup heading="Quick Actions">
                  {filteredActions.map((action) => (
                    <CommandItem
                      key={action.id}
                      onSelect={() => goToPage(action.path, action.search)}
                    >
                      <action.icon className="size-4" />
                      <span>{action.name}</span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              </>
            )}

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
                    <span className="text-muted-foreground">"{search}"</span>
                  </span>
                </CommandItem>
              </CommandGroup>
            )}

            {/* Default view when not searching */}
            {!hasSearch && !searchScope && !isLoading && (
              <>
                {recents.length > 0 && (
                  <CommandGroup heading="Jump back">
                    {recents.map((recent) => (
                      <CommandItem
                        key={`recent-${recent.entityType}-${recent.id}`}
                        value={`recent-${recent.id}`}
                        onSelect={() =>
                          goToEntity(recent.entityType, recent.id, recent.name)
                        }
                        className="flex items-center gap-2"
                      >
                        <IconTile
                          size="sm"
                          className={cn(
                            "size-6 rounded",
                            entities[entityTypeMap[recent.entityType]]?.color
                              .bg ?? "bg-muted/50",
                            entities[entityTypeMap[recent.entityType]]?.color
                              .text,
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
                )}
                <CommandGroup heading="Quick Actions">
                  {filteredActions.map((action) => (
                    <CommandItem
                      key={action.id}
                      onSelect={() => goToPage(action.path, action.search)}
                    >
                      <action.icon className="size-4" />
                      <span>{action.name}</span>
                    </CommandItem>
                  ))}
                </CommandGroup>
                <CommandSeparator />
                <CommandGroup heading="Go to">
                  {goToLeaves.map((leaf) => (
                    <CommandItem
                      key={leaf.to as string}
                      onSelect={() => goToPage(leaf.to as string)}
                    >
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
                      setOpen(false);
                    }}
                  >
                    <Settings className="size-4" />
                    <span>Settings</span>
                  </CommandItem>
                  <CommandItem
                    onSelect={() => {
                      setFlag("perfOverlay", !perfOverlayOn);
                      setOpen(false);
                    }}
                  >
                    <Activity className="size-4" />
                    <span>
                      {perfOverlayOn ? "Hide" : "Show"} performance overlay
                    </span>
                  </CommandItem>
                  <CommandItem
                    onSelect={() => {
                      toggleDevtools();
                      setOpen(false);
                    }}
                  >
                    <Wrench className="size-4" />
                    <span>{isDevtoolsVisible ? "Hide" : "Show"} Devtools</span>
                  </CommandItem>
                </CommandGroup>
                <div className="px-2 pt-2 pb-1 text-muted-foreground text-xs">
                  Tip: paste a shortcode (PRD-, LOC-, RCP-…) to jump instantly.
                </div>
              </>
            )}
          </>
        )}
      </CommandList>
    </CommandDialog>
  );
}

function CommandSearchSpinner() {
  return (
    <Row align="center" justify="center" className="py-6">
      <Spinner className="text-muted-foreground" />
    </Row>
  );
}
