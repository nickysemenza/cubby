import type { SearchableEntity } from "@cubby/schemas/search";
import { parseShortcode } from "@cubby/shared";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  BookOpen,
  ClipboardList,
  ExternalLink,
  Hammer,
  MapPin,
  Package,
  Search,
  Settings,
  ShoppingCart,
} from "lucide-react";
import * as React from "react";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "~/components/ui/command";
import { Spinner } from "~/components/ui/spinner";
import { entities } from "~/entities/entities";
import { useDebug } from "~/hooks/useDebug";
import { useTRPC } from "~/trpc/react";
import { useGlobalSearch } from "./command-menu/use-global-search";
import {
  entityTypeMap,
  getEnrichmentText,
  SearchResultItemIcon,
} from "./search/search-utils";

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

  const { results, filteredActions, isLoading, isEmpty } =
    useGlobalSearch(search);

  // Notion data — already cached from dashboard, filter client-side
  const trpc = useTRPC();
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
      navigate({ to: `/locations/${locationQuery.data.id}` });
      setOpen(false);
    } else if (parsedShortcode?.type === "product" && productQuery.data) {
      navigate({ to: `/products/${productQuery.data.id}` });
      setOpen(false);
    } else if (parsedShortcode?.type === "recipe" && recipeQuery.data) {
      navigate({ to: `/recipes/${recipeQuery.data.id}` });
      setOpen(false);
    }
  };

  React.useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen(!open);
      }
    };

    document.addEventListener("keydown", down);
    return () => document.removeEventListener("keydown", down);
  }, [open, setOpen]);

  // Reset search when dialog closes
  React.useEffect(() => {
    if (!open) {
      setSearch("");
    }
  }, [open]);

  const goToEntity = (entityType: SearchableEntity, id: string) => {
    const entity = entities[entityTypeMap[entityType]];
    if (entity) {
      navigate({ to: `/${entity.basePath}/${id}` });
      setOpen(false);
    }
  };

  const goToPage = (path: string) => {
    navigate({ to: path });
    setOpen(false);
  };

  // Determine what to show based on search state
  const hasSearch = search.length > 0;
  const hasResults = results && results.length > 0;

  // Group search results by entity type for section headers
  const groupedResults = React.useMemo(() => {
    if (!results) return [];
    const groups: Array<{
      entityType: SearchableEntity;
      label: string;
      items: typeof results;
    }> = [];
    const byType = new Map<SearchableEntity, typeof results>();

    for (const item of results) {
      const existing = byType.get(item.entityType);
      if (existing) {
        existing.push(item);
      } else {
        const arr = [item];
        byType.set(item.entityType, arr);
        groups.push({
          entityType: item.entityType,
          label: entities[entityTypeMap[item.entityType]].pluralLabel,
          items: arr,
        });
      }
    }
    return groups;
  }, [results]);

  return (
    <CommandDialog
      open={open}
      onOpenChange={setOpen}
      shouldFilter={false}
      className="sm:max-w-2xl"
    >
      <CommandInput
        placeholder="Search products, recipes, locations, projects..."
        value={search}
        onValueChange={setSearch}
      />
      <CommandList className="max-h-96">
        {/* Loading state */}
        {isLoading && (
          <div className="flex items-center justify-center py-6">
            <Spinner className="text-muted-foreground" />
          </div>
        )}

        {/* Empty state */}
        {isEmpty && !isLoading && !shortcodeResult && !notionResults && (
          <CommandEmpty>No results found.</CommandEmpty>
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
          <>
            {groupedResults.map((group) => (
              <CommandGroup key={group.entityType} heading={group.label}>
                {group.items.map((item) => {
                  const enrichment = getEnrichmentText(item);

                  return (
                    <CommandItem
                      key={`${item.entityType}-${item.id}`}
                      onSelect={() => goToEntity(item.entityType, item.id)}
                      className="flex items-center gap-3"
                    >
                      {item.imageUrl ? (
                        <img
                          src={item.imageUrl}
                          alt=""
                          className="h-8 w-8 shrink-0 rounded object-cover"
                        />
                      ) : (
                        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded bg-muted/50">
                          <SearchResultItemIcon
                            item={item}
                            className="h-4 w-4 shrink-0"
                          />
                        </div>
                      )}
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm">{item.name}</div>
                        {(item.subtitle || enrichment) && (
                          <div className="truncate text-muted-foreground text-xs">
                            {[item.subtitle, enrichment]
                              .filter(Boolean)
                              .join(" · ")}
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
          </>
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
                    className="flex items-center gap-3"
                  >
                    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded bg-muted/50">
                      {p.icon ? (
                        <span className="text-base">{p.icon}</span>
                      ) : (
                        <Hammer className="h-4 w-4" />
                      )}
                    </div>
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
                    className="flex items-center gap-3"
                  >
                    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded bg-muted/50">
                      <ClipboardList className="h-4 w-4" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm">{t.name}</div>
                      <div className="truncate text-muted-foreground text-xs">
                        {[t.status, t.projectName].filter(Boolean).join(" · ")}
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
                    className="flex items-center gap-3"
                  >
                    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded bg-muted/50">
                      <ShoppingCart className="h-4 w-4" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm">{p.name}</div>
                      <div className="truncate text-muted-foreground text-xs">
                        {[
                          p.cost != null ? `$${p.cost.toLocaleString()}` : null,
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
              {Object.values(entities).map((entity) => (
                <CommandItem
                  key={entity.basePath}
                  onSelect={() => goToPage(`/${entity.basePath}`)}
                >
                  <entity.lucideIcon className="h-4 w-4" />
                  <span>{entity.pluralLabel}</span>
                </CommandItem>
              ))}
            </CommandGroup>
            <CommandSeparator />
            <CommandGroup heading="Settings">
              <CommandItem
                onSelect={() => {
                  toggleDevtools();
                  setOpen(false);
                }}
              >
                <Settings className="h-4 w-4" />
                <span>{isDevtoolsVisible ? "Hide" : "Show"} Devtools</span>
              </CommandItem>
            </CommandGroup>
          </>
        )}
      </CommandList>
    </CommandDialog>
  );
}
