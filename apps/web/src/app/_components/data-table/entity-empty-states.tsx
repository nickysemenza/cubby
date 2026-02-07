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
      "Start building your collection of favorite recipes. Import from a URL or create from scratch.",
    actionLabel: "Create Recipe",
  },
  product: {
    title: "No products tracked yet",
    description:
      "Add products to track inventory and pricing. Scan barcodes or add manually.",
    actionLabel: "Add Product",
  },
  ingredient: {
    title: "Ingredient library is empty",
    description:
      "Build your ingredient library to connect recipes with products and nutrition data.",
    actionLabel: "Add Ingredient",
  },
  location: {
    title: "Set up your storage spaces",
    description:
      "Create locations to organize where you store things. Pantry, fridge, garage - you decide.",
    actionLabel: "Create Location",
  },
  inventory: {
    title: "Nothing in stock",
    description:
      "Start tracking what you have and where. Scan barcodes or add items manually.",
    actionLabel: "Add to Inventory",
  },
  image: {
    title: "No images uploaded",
    description:
      "Upload images to attach them to recipes, products, and locations.",
  },
  "usda-food": {
    title: "No USDA foods found",
    description:
      "Search the USDA database for nutrition information and food data.",
  },
};

interface EntityEmptyStateProps {
  entity: Entity;
  /** Override to show "no results" state (filtered empty) vs "truly empty" state */
  isFiltered?: boolean;
}

/**
 * Entity-specific empty state for tables.
 * Shows contextual messaging and actions based on entity type.
 * Uses consistent icons and colors from the entity system.
 */
export function EntityEmptyState({
  entity,
  isFiltered = false,
}: EntityEmptyStateProps) {
  // If filtered, show generic "no results" message
  if (isFiltered) {
    return <FilteredEmptyState />;
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
function FilteredEmptyState() {
  return (
    <Empty variant="minimal" className="py-6">
      <EmptyTitle>No results found</EmptyTitle>
      <EmptyDescription>
        Try adjusting your search or filters to find what you're looking for.
      </EmptyDescription>
    </Empty>
  );
}

/** Check if a table has active filters */
export function hasActiveFilters(columnFilters: unknown[]): boolean {
  return columnFilters.length > 0;
}
