import type { Entity } from "@cubby/schemas/entity";
import { Link } from "@tanstack/react-router";
import { Button } from "~/components/ui/button";
import {
  Empty,
  EmptyActions,
  EmptyDescription,
  EmptyMedia,
  EmptyTitle,
} from "~/components/ui/empty";
import { EntityIcon, entities } from "~/entities/entities";

interface EntityEmptyConfig {
  title: string;
  description: string;
  /** If not provided, no action button is shown */
  actionLabel?: string;
}

const entityEmptyConfig: Record<Entity, EntityEmptyConfig> = {
  recipe: {
    title: "Your recipe book awaits",
    description:
      "Start a collection of recipes you love. Import one from a URL, or write it from scratch.",
    actionLabel: "Create Recipe",
  },
  product: {
    title: "Nothing on the shelves yet",
    description:
      "Add the things you own to track what you have and what it's worth. Scan a barcode or add one by hand.",
    actionLabel: "Add Product",
  },
  ingredient: {
    title: "Your pantry list is empty",
    description:
      "Build a list of ingredients to connect your recipes with what's in stock.",
    actionLabel: "Add Ingredient",
  },
  location: {
    title: "Nowhere to put things yet",
    description:
      "Create spaces to organize where everything lives — pantry, fridge, garage, you decide.",
    actionLabel: "Create Location",
  },
  inventory: {
    title: "Your cubbies are empty",
    description:
      "Start tracking what you have and where it lives. Scan a barcode or add it by hand.",
    actionLabel: "Add to Inventory",
  },
  image: {
    title: "No photos yet",
    description: "Add photos to attach them to recipes, products, and places.",
  },
  "usda-food": {
    title: "Nothing found in the USDA database",
    description: "Search for a food to pull in its nutrition details.",
  },
};

interface EntityEmptyStateProps {
  entity: Entity;
  /** Override to show "no results" state (filtered empty) vs "truly empty" state */
  isFiltered?: boolean;
  /** Callback to clear all active filters */
  onClearFilters?: () => void;
}

/**
 * Entity-specific empty state for tables.
 * Shows contextual messaging and actions based on entity type.
 * Uses consistent icons and colors from the entity system.
 */
export function EntityEmptyState({
  entity,
  isFiltered = false,
  onClearFilters,
}: EntityEmptyStateProps) {
  // If filtered, show generic "no results" message with clear option
  if (isFiltered) {
    return <FilteredEmptyState onClearFilters={onClearFilters} />;
  }

  const config = entityEmptyConfig[entity];
  const entityDef = entities[entity];

  if (!config || !entityDef) {
    return <FilteredEmptyState />;
  }

  // Build the "new" action URL from entity basePath
  const actionHref = `/${entityDef.basePath}/new`;

  return (
    <Empty variant="warm" className="py-8">
      <EmptyMedia variant="icon">
        <EntityIcon entity={entity} colored className="size-5" />
      </EmptyMedia>
      <EmptyTitle>{config.title}</EmptyTitle>
      <EmptyDescription>{config.description}</EmptyDescription>
      {config.actionLabel && (
        <EmptyActions>
          <Link to={actionHref}>
            <Button size="sm">{config.actionLabel}</Button>
          </Link>
        </EmptyActions>
      )}
    </Empty>
  );
}

/** Generic empty state for filtered results */
function FilteredEmptyState({
  onClearFilters,
}: {
  onClearFilters?: () => void;
}) {
  return (
    <Empty variant="minimal" className="py-6">
      <EmptyTitle>Nothing matched</EmptyTitle>
      <EmptyDescription>
        Try a different search, or clear the filters to see everything.
      </EmptyDescription>
      {onClearFilters && (
        <EmptyActions>
          <Button size="sm" variant="outline" onClick={onClearFilters}>
            Clear filters
          </Button>
        </EmptyActions>
      )}
    </Empty>
  );
}

/** Check if a table has active filters (column filters or global search text) */
export function hasActiveFilters(
  columnFilters: unknown[],
  globalFilter?: string,
): boolean {
  return columnFilters.length > 0 || (!!globalFilter && globalFilter !== "");
}
