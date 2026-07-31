import type { AgentResult } from "@cubby/schemas/agent";
import { searchableEntities } from "@cubby/schemas/entity-manifest";
import type { SearchableEntity, SearchResultItem } from "@cubby/schemas/search";
import { parseShortcode, type ShortcodeType } from "@cubby/shared";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  Activity,
  ArrowLeft,
  BookOpen,
  Equal,
  MapPin,
  Package,
  Search,
  Settings,
  Sparkles,
  Wrench,
  X,
} from "lucide-react";
import * as React from "react";
import { toast } from "sonner";
import { Row, Stack } from "~/components/layout";
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
import { AgentAnswer, AgentSourceContent } from "./agent/AgentAnswer";
import { quickActions } from "./command-menu/quick-actions";
import { getRecents, pushRecent } from "./command-menu/recents";
import { parseCommandSearchScope } from "./command-menu/search-scope";
import { useConversionAnswer } from "./command-menu/use-conversion-answer";
import { useGlobalSearch } from "./command-menu/use-global-search";
import { useAgentStream } from "./hooks/useAgentStream";
import { desktopLeaves } from "./navigation/nav-items";
import {
  entityTypeMap,
  getEnrichmentText,
  getSearchMatchText,
  getSearchResultRoute,
  rememberSearchResult,
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

  const { results, filteredActions, isLoading, isFetching, isEmpty } =
    useGlobalSearch(search, searchScope ?? undefined);
  const conversion = useConversionAnswer(searchScope ? "" : search);

  const trpc = useTRPC();

  // --- Agent ("Ask Cubby") ---
  // Opt-in: the agent only runs when the user explicitly selects the Ask item.
  // Keyword/shortcode fast paths stay instant and untouched. Streams the
  // answer for a progressive "typing" reveal.
  const [answerMode, setAnswerMode] = React.useState(false);
  const agent = useAgentStream();
  const runAsk = (query: string) => {
    const trimmed = query.trim();
    if (trimmed.length === 0) return;
    setAnswerMode(true);
    agent.ask(trimmed);
  };
  const exitAnswerMode = () => {
    setAnswerMode(false);
    agent.reset();
  };
  // Surface stream errors as a toast.
  const agentError = agent.error;
  React.useEffect(() => {
    if (agentError) toast.error(agentError);
  }, [agentError]);
  // Shortcode detection and lookup. The queries exist only to PREVIEW the name
  // in the menu — navigation needs no lookup at all, since the prefix already
  // names the entity and the code is the URL. They key on the canonical form so
  // a typed legacy code (`P-4K7M`) previews as well as a current one.
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

  const goToShortcode = () => {
    if (!parsedShortcode) return;
    // Recents needs a name, so it only gets an entry once the preview query has
    // landed — navigation itself never waits on it. `entityType` is narrowed to
    // the SEARCHABLE entities: vendor and purchase have shortcodes but aren't in
    // that union, and they have no preview query here either.
    if (shortcodeResult && isSearchableEntity(parsedShortcode.type)) {
      pushRecent({
        entityType: parsedShortcode.type,
        id: parsedShortcode.shortcode,
        name: shortcodeResult.name,
      });
    }
    navigate({
      to: entities[parsedShortcode.type].routes.detail,
      params: entityDetailParams(parsedShortcode.shortcode),
    });
    setOpen(false);
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
      agent.reset();
    }
  }, [open, agent.reset]);

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

  const goToSearchResult = (item: SearchResultItem) => {
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
          <AnswerView
            query={search}
            answer={agent.answer}
            toolStatus={agent.toolStatus}
            isStreaming={agent.isStreaming}
            sources={agent.result?.sources ?? []}
            toolCalls={agent.result?.toolCalls ?? []}
            showToolCalls={isDevtoolsVisible}
            onBack={exitAnswerMode}
            onSelectSource={goToSource}
          />
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
            {isEmpty && !isLoading && !shortcodeResult && (
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

            {/* Shortcode result - appears at top when typing a valid shortcode */}
            {parsedShortcode && shortcodeResult && (
              <CommandGroup heading="Shortcode">
                <CommandItem
                  onSelect={goToShortcode}
                  className="flex items-center gap-2"
                >
                  {parsedShortcode.type === "location" ? (
                    <MapPin className="size-4" />
                  ) : parsedShortcode.type === "product" ? (
                    <Package className="size-4" />
                  ) : (
                    <BookOpen className="size-4" />
                  )}
                  <span>{shortcodeResult.name}</span>
                  <span className="ml-auto font-mono text-muted-foreground text-xs">
                    {search.toUpperCase()}
                  </span>
                </CommandItem>
              </CommandGroup>
            )}

            {/* Search results — preserve the server's global rank order. */}
            {hasResults && !isLoading && (
              <div
                className={cn("transition-opacity", isFetching && "opacity-60")}
              >
                <CommandGroup
                  heading={
                    scopeLabel ? `${scopeLabel} matches` : "Best matches"
                  }
                >
                  {results.map((item) => {
                    const enrichment = getEnrichmentText(item);
                    const matchText = getSearchMatchText(item);

                    return (
                      <CommandItem
                        key={`${item.entityType}-${item.id}`}
                        onSelect={() => goToSearchResult(item)}
                        className="flex items-center gap-2"
                      >
                        <SearchResultMedia item={item} />
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm">{item.name}</div>
                          {(item.subtitle || enrichment) && (
                            <div className="truncate text-muted-foreground text-xs">
                              {[item.subtitle, enrichment]
                                .filter(Boolean)
                                .join(" · ")}
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
                  Tip: type a shortcode (P-, L-, R-…) to jump straight to an
                  item.
                </div>
              </>
            )}
          </>
        )}
      </CommandList>
    </CommandDialog>
  );
}

interface AnswerViewProps {
  query: string;
  answer: string;
  toolStatus: string | null;
  isStreaming: boolean;
  sources: AgentResult["sources"];
  toolCalls: AgentResult["toolCalls"];
  showToolCalls: boolean;
  onBack: () => void;
  /** `shortcode` is null when the tool payload carried no public id. */
  onSelectSource: (
    entityType: SearchableEntity,
    shortcode: string | null,
    name?: string,
  ) => void;
}

/**
 * Answer-mode body for the command palette. Wraps the shared {@link AgentAnswer}
 * core in cmdk chrome — a "Back to search" `CommandItem`, `CommandGroup`
 * headings, and `CommandItem` sources for keyboard nav.
 */
function AnswerView({
  query,
  answer,
  toolStatus,
  isStreaming,
  sources,
  toolCalls,
  showToolCalls,
  onBack,
  onSelectSource,
}: AnswerViewProps) {
  return (
    <>
      <CommandGroup>
        <CommandItem
          value="ask-back"
          onSelect={onBack}
          className="flex items-center gap-2 text-muted-foreground"
        >
          <ArrowLeft className="size-4" />
          <span>Back to search</span>
        </CommandItem>
      </CommandGroup>

      <AgentAnswer
        answer={answer}
        toolStatus={toolStatus}
        isStreaming={isStreaming}
        sources={sources}
        answerWrapper={(children) => (
          <CommandGroup heading={`Answer · "${query}"`}>
            {children}
          </CommandGroup>
        )}
        sourcesWrapper={(children) => (
          <CommandGroup heading="Sources">{children}</CommandGroup>
        )}
        renderSource={(source) => (
          <CommandItem
            key={`${source.entityType}-${source.id}`}
            value={`source-${source.entityType}-${source.id}`}
            onSelect={() =>
              onSelectSource(source.entityType, source.id, source.name)
            }
            className="flex items-center gap-2"
          >
            <AgentSourceContent source={source} />
          </CommandItem>
        )}
        toolCalls={
          showToolCalls && toolCalls.length > 0 ? (
            <CommandGroup heading="Tool calls">
              <Stack gap="xs" className="px-2 py-1">
                {toolCalls.map((call, i) => (
                  <Row
                    // biome-ignore lint/suspicious/noArrayIndexKey: ordered log, no stable id
                    key={i}
                    align="center"
                    gap="sm"
                    className="font-mono text-muted-foreground text-xs"
                  >
                    <span
                      className={call.ok ? "text-primary" : "text-destructive"}
                    >
                      {call.ok ? "✓" : "✗"}
                    </span>
                    <span>{call.tool}</span>
                    <span className="ml-auto">{call.durationMs}ms</span>
                  </Row>
                ))}
              </Stack>
            </CommandGroup>
          ) : undefined
        }
      />
    </>
  );
}
