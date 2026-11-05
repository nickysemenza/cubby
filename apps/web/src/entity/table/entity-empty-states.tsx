import type { Entity } from "@cubby/schemas/entity";
import type { BrowserRoutedEntity } from "@cubby/schemas/entity-manifest";
import { MagnifyingGlassIcon } from "@phosphor-icons/react/dist/csr/MagnifyingGlass";
import { Link } from "@tanstack/react-router";
import type { RowData } from "@tanstack/react-table";

import { createActionFor } from "~/entity/actions/action-items";
import { entities, isBrowserRoutedEntity } from "~/entity/entities";
import { useEntityMetadata } from "~/entity/metadata";
import { EmptyState } from "~/ui/feedback/empty-state";
import { Button, buttonVariants } from "~/ui/primitives/button";

import type { CubbyTable as Table } from "../../ui/data-table/table-features";

/**
 * Empty-state copy comes from each declaration's `presentation.emptyState`
 * (packages/schemas/src/entity-definitions/*.entity.ts). Nothing here is
 * per-entity: a new entity brings its own title, description and optional
 * create label, and the drift guard in `actions/action-items.unit.test.ts`
 * still checks every `actionLabel` resolves to something to click.
 */

interface EntityEmptyStateProps {
  entity: BrowserRoutedEntity;
  isFiltered?: boolean;
  onClearFilters?: () => void;
}

export function EntityEmptyState({
  entity,
  isFiltered = false,
  onClearFilters,
}: EntityEmptyStateProps) {
  const config = useEntityMetadata(entity).summary.emptyState;
  const actionLabel = "actionLabel" in config ? config.actionLabel : undefined;
  if (isFiltered) {
    return <FilteredEmptyState onClearFilters={onClearFilters} />;
  }

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
    <EmptyState
      size="page"
      icon={entityDef.phosphorIcon}
      description={config.description}
      action={
        actionLabel && createTarget ? (
          <Link
            to={createTarget.to}
            search={createTarget.search}
            className={buttonVariants({ variant: "outline", size: "sm" })}
          >
            {actionLabel}
          </Link>
        ) : undefined
      }
    >
      {config.title}
    </EmptyState>
  );
}

function FilteredEmptyState({
  isFiltered = true,
  onClearFilters,
}: {
  isFiltered?: boolean;
  onClearFilters?: () => void;
}) {
  return (
    <EmptyState
      size="page"
      description={
        isFiltered
          ? "Try a different search, or clear the filters to see everything."
          : "There's nothing to show yet."
      }
      icon={MagnifyingGlassIcon}
      action={
        isFiltered && onClearFilters ? (
          <Button size="sm" variant="outline" onClick={onClearFilters}>
            Clear filters
          </Button>
        ) : undefined
      }
    >
      {isFiltered ? "Nothing matched" : "Nothing here yet"}
    </EmptyState>
  );
}

/** One recovery contract for table, phone, and shelf presentations. */
export function TableEmptyState<TData extends RowData>({
  entity,
  table,
  additionalFilterActive = false,
  onClearAdditionalFilters,
}: {
  entity?: Entity;
  table: Table<TData>;
  additionalFilterActive?: boolean;
  onClearAdditionalFilters?: () => void;
}) {
  const isFiltered =
    table.state.columnFilters.length > 0 || additionalFilterActive;
  const onClearFilters = isFiltered
    ? () => {
        table.resetColumnFilters();
        onClearAdditionalFilters?.();
      }
    : undefined;
  return entity && isBrowserRoutedEntity(entity) ? (
    <EntityEmptyState
      entity={entity}
      isFiltered={isFiltered}
      onClearFilters={onClearFilters}
    />
  ) : (
    <FilteredEmptyState
      isFiltered={isFiltered}
      onClearFilters={onClearFilters}
    />
  );
}
