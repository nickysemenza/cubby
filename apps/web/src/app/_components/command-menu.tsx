import type { AgentResult } from "@cubby/schemas/agent";
import type { SearchableEntity, SearchResultItem } from "@cubby/schemas/search";
import { parseShortcode } from "@cubby/shared";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  Activity,
  ArrowLeft,
  BookOpen,
  ClipboardList,
  Equal,
  ExternalLink,
  Hammer,
  MapPin,
  Package,
  Search,
  Settings,
  ShoppingCart,
  Sparkles,
  Wrench,
} from "lucide-react";
import * as React from "react";
import { toast } from "sonner";
import { Row, Stack } from "~/components/layout";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "~/components/ui/command";
import { IconTile } from "~/components/ui/icon-tile";
import { Spinner } from "~/components/ui/spinner";
import { EntityIcon, entities } from "~/entities/entities";
import { useDebug } from "~/hooks/useDebug";
import { setFlag, useFlag } from "~/lib/flags";
import { cn, formatCurrency } from "~/lib/utils";
import { useTRPC } from "~/trpc/react";
import { AgentAnswer, AgentSourceContent } from "./agent/AgentAnswer";
import { quickActions } from "./command-menu/quick-actions";
import { getRecents, pushRecent } from "./command-menu/recents";
import { useConversionAnswer } from "./command-menu/use-conversion-answer";
import { useGlobalSearch } from "./command-menu/use-global-search";
import { useAgentStream } from "./hooks/useAgentStream";
import { desktopLeaves } from "./navigation/nav-items";
import {
  entityTypeMap,
  getEnrichmentText,
  getSearchMatchText,
  getSearchResultRoute,
  groupSearchResults,
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

export function GlobalCommandMenu({
  open: externalOpen,
  onOpenChange: externalOnOpenChange,
}: GlobalCommandMenuProps = {}) {
  const [internalOpen, setInternalOpen] = React.useState(false);

  // Use external control if provided, otherwise use internal state
  const open = externalOpen ?? internalOpen;
  const setOpen = externalOnOpenChange ?? setInternalOpen;
  const [search, setSearch] = React.useState("");
  const navigate = useNavigate();
  const { isDevtoolsVisible, toggleDevtools } = useDebug();
  const perfOverlayOn = useFlag("perfOverlay");

  const { results, filteredActions, isLoading, isFetching, isEmpty } =
    useGlobalSearch(search);
  const conversion = useConversionAnswer(search);

  // Notion data — already cached from dashboard, filter client-side
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
  const { data: notionData } = useQuery({
    ...trpc.notion.dashboard.queryOptions(),
    staleTime: 5 * 60 * 1000,
  });

  const notionResults = React.useMemo(() => {
    if (!notionData || !search || search.length < 2) return null;
    const q = search.toLowerCase();

    const projects = notionData.projects
      .filter((p) => p.name.toLowerCase().includes(q))
      .slice(0, 5);
    const tasks = notionData.tasks
      .filter((t) => t.name.toLowerCase().includes(q))
      .slice(0, 5);
    const purchases = notionData.purchases
      .filter((p) => p.name.toLowerCase().includes(q))
      .slice(0, 5);

    if (projects.length === 0 && tasks.length === 0 && purchases.length === 0)
      return null;
    return { projects, tasks, purchases };
  }, [notionData, search]);

  // Shortcode detection and lookup
  const parsedShortcode = parseShortcode(search);
  const locationQuery = useQuery({
    ...trpc.location.getByShortcode.queryOptions({
      shortcode: search.toUpperCase(),
    }),
    enabled: parsedShortcode?.type === "location",
  });
  const productQuery = useQuery({
    ...trpc.product.getByShortcode.queryOptions({
      shortcode: search.toUpperCase(),
    }),
    enabled: parsedShortcode?.type === "product",
  });
  const recipeQuery = useQuery({
    ...trpc.recipe.getByShortcode.queryOptions({
      shortcode: search.toUpperCase(),
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
    if (parsedShortcode?.type === "location" && locationQuery.data) {
      pushRecent({
        entityType: "location",
        id: locationQuery.data.id,
        name: locationQuery.data.name,
      });
      navigate({ to: `/locations/${locationQuery.data.id}` });
      setOpen(false);
    } else if (parsedShortcode?.type === "product" && productQuery.data) {
      pushRecent({
        entityType: "product",
        id: productQuery.data.id,
        name: productQuery.data.name,
      });
      navigate({ to: `/products/${productQuery.data.id}` });
      setOpen(false);
    } else if (parsedShortcode?.type === "recipe" && recipeQuery.data) {
      pushRecent({
        entityType: "recipe",
        id: recipeQuery.data.id,
        name: recipeQuery.data.name,
      });
      navigate({ to: `/recipes/${recipeQuery.data.id}` });
      setOpen(false);
    }
  };

  // The ⌘K hotkey is owned by the app shell (__root.tsx) so the shortcut works
  // before this (lazily loaded) menu has mounted. Don't register it here too,
  // or it would double-toggle once mounted.

  // Reset search and answer mode when dialog closes
  React.useEffect(() => {
    if (!open) {
      setSearch("");
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
    id: string,
    name?: string,
  ) => {
    const entity = entities[entityTypeMap[entityType]];
    if (entity) {
      if (name) pushRecent({ entityType, id, name });
      navigate({ to: `/${entity.basePath}/${id}` });
      setOpen(false);
    }
  };

  const goToSearchResult = (item: SearchResultItem) => {
    rememberSearchResult(item);
    navigate(getSearchResultRoute(item));
    setOpen(false);
  };

  const goToPage = (path: string) => {
    navigate({ to: path });
    setOpen(false);
  };

  // Determine what to show based on search state
  const hasSearch = search.length > 0;
  const hasResults = results && results.length > 0;

  // Group search results by entity type for section headers
  const groupedResults = React.useMemo(
    () => groupSearchResults(results ?? []),
    [results],
  );

  return (
    <CommandDialog
      open={open}
      onOpenChange={setOpen}
      shouldFilter={false}
      className="sm:max-w-2xl"
    >
      <CommandInput
        placeholder="Search, jump to a page, or ask Cubby…"
        value={search}
        onValueChange={setSearch}
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
            onSelectSource={(entityType, id, name) =>
              goToEntity(entityType, id, name)
            }
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
                      conversion.ingredientId,
                      conversion.ingredientName,
                    )
                  }
                  className="flex items-center gap-2"
                >
                  <Equal className="h-4 w-4 shrink-0 text-primary" />
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

            {/* Ask Cubby — opt-in agent, pinned at top while searching */}
            {hasSearch && (
              <CommandGroup>
                <CommandItem
                  value={`ask-cubby-${search}`}
                  onSelect={() => runAsk(search)}
                  className="flex items-center gap-2"
                >
                  <Sparkles className="h-4 w-4 text-primary" />
                  <span className="truncate">
                    Ask Cubby:{" "}
                    <span className="text-muted-foreground">"{search}"</span>
                  </span>
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
            {isEmpty && !isLoading && !shortcodeResult && !notionResults && (
              <CommandEmpty>Nothing matched — try another word.</CommandEmpty>
            )}

            {/* Shortcode result - appears at top when typing a valid shortcode */}
            {parsedShortcode && shortcodeResult && (
              <CommandGroup heading="Shortcode">
                <CommandItem
                  onSelect={goToShortcode}
                  className="flex items-center gap-2"
                >
                  {parsedShortcode.type === "location" ? (
                    <MapPin className="h-4 w-4" />
                  ) : parsedShortcode.type === "product" ? (
                    <Package className="h-4 w-4" />
                  ) : (
                    <BookOpen className="h-4 w-4" />
                  )}
                  <span>{shortcodeResult.name}</span>
                  <span className="ml-auto font-mono text-muted-foreground text-xs">
                    {search.toUpperCase()}
                  </span>
                </CommandItem>
              </CommandGroup>
            )}

            {/* Search Results - grouped by entity type with icon placeholders */}
            {hasResults && !isLoading && (
              <div
                className={cn("transition-opacity", isFetching && "opacity-60")}
              >
                {groupedResults.map((group) => (
                  <CommandGroup key={group.entityType} heading={group.label}>
                    {group.items.map((item) => {
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
                            {matchText && (
                              <div
                                className="truncate text-2xs text-muted-foreground/80"
                                title={item.matchReason}
                              >
                                {matchText}
                              </div>
                            )}
                          </div>
                        </CommandItem>
                      );
                    })}
                  </CommandGroup>
                ))}
                <CommandGroup>
                  <CommandItem
                    onSelect={() => {
                      navigate({ to: "/search", search: { q: search } });
                      setOpen(false);
                    }}
                    className="justify-center text-muted-foreground"
                  >
                    <Search className="mr-2 h-4 w-4" />
                    See all results for "{search}"
                  </CommandItem>
                </CommandGroup>
              </div>
            )}

            {/* Notion results — filtered from cached dashboard data */}
            {notionResults && !isLoading && (
              <>
                {notionResults.projects.length > 0 && (
                  <CommandGroup heading="Projects (Notion)">
                    {notionResults.projects.map((p) => (
                      <CommandItem
                        key={`notion-project-${p.id}`}
                        onSelect={() => {
                          navigate({
                            to: "/projects/$id",
                            params: { id: p.id },
                          });
                          setOpen(false);
                        }}
                        className="flex items-center gap-2"
                      >
                        <IconTile size="md" className="rounded bg-muted/50">
                          {p.icon ? (
                            <span className="text-base">{p.icon}</span>
                          ) : (
                            <Hammer className="h-4 w-4" />
                          )}
                        </IconTile>
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm">{p.name}</div>
                          <div className="truncate text-muted-foreground text-xs">
                            {[p.status, p.kind].filter(Boolean).join(" · ")}
                          </div>
                        </div>
                      </CommandItem>
                    ))}
                  </CommandGroup>
                )}
                {notionResults.tasks.length > 0 && (
                  <CommandGroup heading="Tasks (Notion)">
                    {notionResults.tasks.map((t) => (
                      <CommandItem
                        key={`notion-task-${t.id}`}
                        onSelect={() => {
                          window.open(t.notionUrl, "_blank");
                          setOpen(false);
                        }}
                        className="flex items-center gap-2"
                      >
                        <IconTile size="md" className="rounded bg-muted/50">
                          <ClipboardList className="h-4 w-4" />
                        </IconTile>
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm">{t.name}</div>
                          <div className="truncate text-muted-foreground text-xs">
                            {[t.status, t.projectName]
                              .filter(Boolean)
                              .join(" · ")}
                          </div>
                        </div>
                        <ExternalLink className="h-3 w-3 shrink-0 text-muted-foreground" />
                      </CommandItem>
                    ))}
                  </CommandGroup>
                )}
                {notionResults.purchases.length > 0 && (
                  <CommandGroup heading="Purchases (Notion)">
                    {notionResults.purchases.map((p) => (
                      <CommandItem
                        key={`notion-purchase-${p.id}`}
                        onSelect={() => {
                          window.open(p.notionUrl, "_blank");
                          setOpen(false);
                        }}
                        className="flex items-center gap-2"
                      >
                        <IconTile size="md" className="rounded bg-muted/50">
                          <ShoppingCart className="h-4 w-4" />
                        </IconTile>
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm">{p.name}</div>
                          <div className="truncate text-muted-foreground text-xs">
                            {[
                              p.cost != null ? formatCurrency(p.cost, 0) : null,
                              p.projectName,
                            ]
                              .filter(Boolean)
                              .join(" · ")}
                          </div>
                        </div>
                        <ExternalLink className="h-3 w-3 shrink-0 text-muted-foreground" />
                      </CommandItem>
                    ))}
                  </CommandGroup>
                )}
              </>
            )}

            {/* Quick Actions - show when searching and matching */}
            {hasSearch && filteredActions.length > 0 && !isLoading && (
              <>
                {hasResults && <CommandSeparator />}
                <CommandGroup heading="Quick Actions">
                  {filteredActions.map((action) => (
                    <CommandItem
                      key={action.id}
                      onSelect={() => goToPage(action.path)}
                    >
                      <action.icon className="h-4 w-4" />
                      <span>{action.name}</span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              </>
            )}

            {/* Default view when not searching */}
            {!hasSearch && !isLoading && (
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
                            className="h-3.5 w-3.5"
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
                      onSelect={() => goToPage(action.path)}
                    >
                      <action.icon className="h-4 w-4" />
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
                      <leaf.icon className="h-4 w-4" />
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
                    <Settings className="h-4 w-4" />
                    <span>Settings</span>
                  </CommandItem>
                  <CommandItem
                    onSelect={() => {
                      setFlag("perfOverlay", !perfOverlayOn);
                      setOpen(false);
                    }}
                  >
                    <Activity className="h-4 w-4" />
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
                    <Wrench className="h-4 w-4" />
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
  onSelectSource: (
    entityType: SearchableEntity,
    id: string,
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
          <ArrowLeft className="h-4 w-4" />
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
