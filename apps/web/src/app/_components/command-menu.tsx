import { useNavigate } from "@tanstack/react-router";
import { Loader2 } from "lucide-react";
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
import type { Entity } from "~/entities/types";
import { formatCurrency } from "~/lib/utils";
import type { LocationType } from "~/schemas/location";
import type { ProductCategory } from "~/schemas/product";
import type { SearchableEntity } from "~/schemas/search";
import { useGlobalSearch } from "./command-menu/use-global-search";
import { tryFormatAmount } from "./inventory/format-amount";
import {
  getLocationIcon,
  getLocationTypeColor,
} from "./locations/location-type-theme";
import { Pill } from "./Pill";
import { getCategoryColor, getCategoryIcon } from "./products/category-theme";

// Map search result entityType to Entity for icons/colors
const entityTypeMap: Record<SearchableEntity, Entity> = {
  product: "product",
  recipe: "recipe",
  ingredient: "ingredient",
  location: "location",
  "inventory-item": "inventory-item",
};

// Helper to format enrichment info for display
type SearchResult = ReturnType<typeof useGlobalSearch>["results"] extends
  | (infer T)[]
  | undefined
  ? T
  : never;

function getEnrichmentText(item: SearchResult): string | null {
  switch (item.entityType) {
    case "product": {
      const parts: string[] = [];
      if (item.price != null) parts.push(formatCurrency(item.price));
      if (item.stockCount != null && item.stockCount > 0)
        parts.push(`${item.stockCount} in stock`);
      return parts.length > 0 ? parts.join(" · ") : null;
    }
    case "location": {
      const parts: string[] = [];
      if (item.itemCount != null && item.itemCount > 0)
        parts.push(`${item.itemCount} items`);
      if (item.childCount != null && item.childCount > 0)
        parts.push(`${item.childCount} sub`);
      return parts.length > 0 ? parts.join(" · ") : null;
    }
    case "inventory-item":
      if (item.amount) return tryFormatAmount(item.amount);
      return null;
    case "recipe":
      if (item.ingredientCount != null && item.ingredientCount > 0)
        return `${item.ingredientCount} ingredients`;
      return null;
    case "ingredient":
      if (item.recipeCount != null && item.recipeCount > 0)
        return `in ${item.recipeCount} recipes`;
      return null;
  }
}

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

              // Determine type-specific icon and color based on typeHint
              const isLocation =
                item.entityType === "location" && item.typeHint;
              const isProduct =
                (item.entityType === "product" ||
                  item.entityType === "inventory-item") &&
                item.typeHint;

              // Get the appropriate icon and color
              let TypeIcon: React.ComponentType<{
                className?: string;
                style?: React.CSSProperties;
              }> | null = null;
              let typeColor: string | undefined;

              if (isLocation) {
                TypeIcon = getLocationIcon(item.typeHint as LocationType);
                typeColor = getLocationTypeColor(item.typeHint as LocationType);
              } else if (isProduct) {
                TypeIcon = getCategoryIcon(item.typeHint as ProductCategory);
                typeColor = getCategoryColor(item.typeHint as ProductCategory);
              }

              const enrichment = getEnrichmentText(item);

              return (
                <CommandItem
                  key={`${item.entityType}-${item.id}`}
                  onSelect={() => goToEntity(item.entityType, item.id)}
                  className="flex items-center gap-2"
                >
                  {TypeIcon ? (
                    <TypeIcon
                      className="h-4 w-4 shrink-0"
                      style={{ color: typeColor }}
                    />
                  ) : (
                    <EntityIcon
                      entity={entity}
                      colored
                      className="h-4 w-4 shrink-0"
                    />
                  )}
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
