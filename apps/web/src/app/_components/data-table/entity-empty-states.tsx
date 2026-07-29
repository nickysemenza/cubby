import type { Entity } from "@cubby/schemas/entity";
import { Link } from "@tanstack/react-router";
import type { Table } from "@tanstack/react-table";
import { IconPattern } from "~/components/common/icon-pattern";
import { Button } from "~/components/ui/button";
import {
  Empty,
  EmptyActions,
  EmptyDescription,
  EmptyMedia,
  EmptyTitle,
} from "~/components/ui/empty";
import { InkStamp } from "~/components/ui/ink-stamp";
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
  cookbook: {
    title: "No cookbooks yet",
    description:
      "Drag an EPUB cookbook into the Recipes import page and Cubby will extract its recipes.",
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
  meal: {
    title: "No meals planned",
    description:
      "Plan recipes onto your calendar to see costs add up and build a shopping list.",
    actionLabel: "Plan a Meal",
  },
  project: {
    title: "No projects yet",
    description:
      "Track household projects from planning to done — budget, timeline, and every task and purchase along the way.",
    actionLabel: "New Project",
  },
  task: {
    title: "No tasks yet",
    description:
      "Break a project down into steps, or jot down a one-off to get to later.",
    actionLabel: "New Task",
  },
  purchase: {
    title: "No purchases yet",
    description:
      "Log what you've bought (or plan to) to keep a project's running cost honest.",
    actionLabel: "New Purchase",
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

  // The create link comes from the typed, optional route registry — not a
  // string synthesized from basePath. Entities without a "new" route (meal,
  // cookbook, usda-food, image) degrade to a description-only empty state
  // instead of rendering a Link to a nonexistent /entity/new (404).
  const newRoute = entityDef.routes.new;

  return (
    <Empty variant="warm" className="relative isolate overflow-hidden py-6">
      <IconPattern className="-z-10" />
      <InkStamp className="mb-1">Nothing on file</InkStamp>
      <EmptyMedia variant="icon">
        <EntityIcon entity={entity} colored className="size-5" />
      </EmptyMedia>
      <EmptyTitle>{config.title}</EmptyTitle>
      <EmptyDescription>{config.description}</EmptyDescription>
      {config.actionLabel && newRoute && (
        <EmptyActions>
          <Link to={newRoute}>
            <Button size="sm">{config.actionLabel}</Button>
          </Link>
        </EmptyActions>
      )}
    </Empty>
  );
}

/**
 * Generic empty state. When `isFiltered`, it reads as "no results, clear the
 * filters"; otherwise it's an honest "nothing here yet" for a genuinely-empty
 * table with no entity-specific CTA (the RTable no-entity fallback).
 */
export function FilteredEmptyState({
  isFiltered = true,
  onClearFilters,
}: {
  isFiltered?: boolean;
  onClearFilters?: () => void;
}) {
  return (
    <Empty variant="minimal" className="py-6">
      <EmptyTitle>
        {isFiltered ? "Nothing matched" : "Nothing here yet"}
      </EmptyTitle>
      <EmptyDescription>
        {isFiltered
          ? "Try a different search, or clear the filters to see everything."
          : "There's nothing to show yet."}
      </EmptyDescription>
      {isFiltered && onClearFilters && (
        <EmptyActions>
          <Button size="sm" variant="outline" onClick={onClearFilters}>
            Clear filters
          </Button>
        </EmptyActions>
      )}
    </Empty>
  );
}

/** Check if a table has active (column) filters. */
export function hasActiveFilters(columnFilters: unknown[]): boolean {
  return columnFilters.length > 0;
}

/**
 * Is the row set narrowed by ANYTHING the user can see — a column filter, or a
 * URL-only scope (`/purchases?productId=…`) that by design never enters
 * `columnFilters`?
 *
 * Only the empty-state COPY keys off this. `resetColumnFilters` can't clear a
 * scope (the page owns that param, and its ScopeChip has the X), so the "Clear
 * filters" button still keys off column filters alone rather than offering a
 * button that wouldn't change anything.
 */
export function isNarrowed<TData>(table: Table<TData>): boolean {
  return (
    hasActiveFilters(table.getState().columnFilters) ||
    (table.options.meta?.urlScopeCount ?? 0) > 0
  );
}
