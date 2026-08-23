import type { Entity } from "@cubby/schemas/entity";
import { Link } from "@tanstack/react-router";
import type { RowData } from "@tanstack/react-table";
import { createActionFor } from "~/app/_components/actions/action-items";
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
import type { CubbyTable as Table } from "./table-features";

interface EntityEmptyConfig {
  title: string;
  description: string;
  actionLabel?: string;
}

const entityEmptyConfig: Record<Entity, EntityEmptyConfig> = {
  person: {
    title: "No people yet",
    description:
      "Add household members and guests to attribute shared spending and account access.",
    actionLabel: "Add Person",
  },
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
      "Track household projects from planning to done — budget, timeline, and every task and expense along the way.",
    actionLabel: "New Project",
  },
  task: {
    title: "No tasks yet",
    description:
      "Break a project down into steps, or jot down a one-off to get to later.",
    actionLabel: "New Task",
  },
  vendor: {
    title: "No vendors yet",
    description:
      "Track the places money goes — retailers, contractors, suppliers — so every purchase and expense can point at one.",
    actionLabel: "Add Vendor",
  },
  purchase: {
    title: "No purchases yet",
    description:
      "A purchase is created automatically the first time an expense records a vendor. Add one directly to file its invoice ahead of time.",
    actionLabel: "New Purchase",
  },
  expense: {
    title: "No expenses yet",
    description:
      "Log what you've bought (or plan to) to keep a project's running cost honest.",
    actionLabel: "New Expense",
  },
  financialAccount: {
    title: "No financial accounts yet",
    description:
      "Add an account to retain statement and receipt evidence for settlement.",
    actionLabel: "New Account",
  },
  financialTransaction: {
    title: "No financial transactions yet",
    description:
      "Record settlement evidence without changing the expense ledger.",
    actionLabel: "New Transaction",
  },
  wish: {
    title: "No tool wishes yet",
    description:
      "Keep a tool idea open-ended or compare a few Products before deciding.",
    actionLabel: "Add Wish",
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
  isFiltered?: boolean;
  onClearFilters?: () => void;
}

export function EntityEmptyState({
  entity,
  isFiltered = false,
  onClearFilters,
}: EntityEmptyStateProps) {
  if (isFiltered) {
    return <FilteredEmptyState onClearFilters={onClearFilters} />;
  }

  const config = entityEmptyConfig[entity];
  const entityDef = entities[entity];

  if (!config || !entityDef) {
    return <FilteredEmptyState />;
  }

  // The create target comes from the action registry, which knows both shapes:
  // a `/new` route and a `?create=true` dialog. Reading `routes.new` directly
  // is what made meal/project/task render no button at all despite each
  // declaring an `actionLabel` — their create is a dialog, so the route is
  // absent by design. Entities with genuinely no create (cookbook, usda-food,
  // image) still degrade to a description-only empty state.
  const createTarget = createActionFor(entity);

  return (
    <Empty variant="warm" className="relative isolate overflow-hidden py-6">
      <IconPattern className="-z-10" />
      <InkStamp className="mb-1">Nothing on file</InkStamp>
      <EmptyMedia variant="icon">
        <EntityIcon entity={entity} colored className="size-5" />
      </EmptyMedia>
      <EmptyTitle>{config.title}</EmptyTitle>
      <EmptyDescription>{config.description}</EmptyDescription>
      {config.actionLabel && createTarget && (
        <EmptyActions>
          <Link to={createTarget.to} search={createTarget.search}>
            <Button size="sm">{config.actionLabel}</Button>
          </Link>
        </EmptyActions>
      )}
    </Empty>
  );
}

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

export function hasActiveFilters(columnFilters: unknown[]): boolean {
  return columnFilters.length > 0;
}

/**
 * Is the row set narrowed by ANYTHING the user can see — a column filter, or a
 * URL-only scope (`/expenses?productId=…`) that by design never enters
 * `columnFilters`?
 *
 * Only the empty-state COPY keys off this. `resetColumnFilters` can't clear a
 * scope (the page owns that param, and its ScopeChip has the X), so the "Clear
 * filters" button still keys off column filters alone rather than offering a
 * button that wouldn't change anything.
 */
export function isNarrowed<TData extends RowData>(
  table: Table<TData>,
): boolean {
  return (
    hasActiveFilters(table.state.columnFilters) ||
    (table.options.meta?.urlScopeCount ?? 0) > 0
  );
}

/**
 * Exposed for the drift guard in `actions/action-items.unit.test.ts`, which
 * asserts every declared `actionLabel` resolves somewhere to click. Not for
 * rendering — read the config through this module's components.
 */
export const entityEmptyConfigForTest = entityEmptyConfig;
