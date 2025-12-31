import { useNavigate } from "@tanstack/react-router";
import { Loader2, Search } from "lucide-react";
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
import { EntityIcon, entities } from "~/entities/entities";
import type { SearchableEntity } from "~/schemas/search";
import { useGlobalSearch } from "./command-menu/use-global-search";
import { Pill } from "./Pill";
import {
  entityTypeMap,
  getEnrichmentText,
  SearchResultItemIcon,
} from "./search/search-utils";

export function GlobalCommandMenu() {
  const [open, setOpen] = React.useState(false);
  const [search, setSearch] = React.useState("");
  const navigate = useNavigate();

  const { results, filteredActions, isLoading, isEmpty } =
    useGlobalSearch(search);

  React.useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen((open) => !open);
      }
    };

    document.addEventListener("keydown", down);
    return () => document.removeEventListener("keydown", down);
  }, []);

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

  return (
    <CommandDialog
      open={open}
      onOpenChange={setOpen}
      shouldFilter={false}
      className="sm:max-w-2xl"
    >
      <CommandInput
        placeholder="Search products, recipes, locations..."
        value={search}
        onValueChange={setSearch}
      />
      <CommandList className="max-h-96">
        {/* Loading state */}
        {isLoading && (
          <div className="flex items-center justify-center py-6">
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          </div>
        )}

        {/* Empty state */}
        {isEmpty && !isLoading && (
          <CommandEmpty>No results found.</CommandEmpty>
        )}

        {/* Search Results - flat list with type pills */}
        {hasResults && !isLoading && (
          <CommandGroup heading="Results">
            {results.map((item) => {
              const entity = entityTypeMap[item.entityType];
              const entityDef = entities[entity];
              const enrichment = getEnrichmentText(item);

              return (
                <CommandItem
                  key={`${item.entityType}-${item.id}`}
                  onSelect={() => goToEntity(item.entityType, item.id)}
                  className="flex items-center gap-2"
                >
                  <SearchResultItemIcon item={item} />
                  <span className="w-56 min-w-0 shrink-0 truncate">
                    {item.name}
                  </span>
                  <span className="w-32 shrink-0 text-muted-foreground text-xs">
                    {enrichment}
                  </span>
                  <span className="flex-1" />
                  <Pill
                    icon={<EntityIcon entity={entity} size={10} colored />}
                    className="shrink-0"
                    metadata={item.subtitle || undefined}
                  >
                    {entityDef.label}
                  </Pill>
                </CommandItem>
              );
            })}
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
          </>
        )}
      </CommandList>
    </CommandDialog>
  );
}
