import type { BrowserRoutedEntity } from "@cubby/schemas/entity-manifest";
import {
  type EntityPresentation,
  entityPresentation,
} from "@cubby/schemas/entity-presentation";
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

/**
 * Empty-state copy comes from each declaration's `presentation.emptyState`
 * (packages/schemas/src/entity-definitions/*.entity.ts). Nothing here is
 * per-entity: a new entity brings its own title, description and optional
 * create label, and the drift guard in `actions/action-items.unit.test.ts`
 * still checks every `actionLabel` resolves to something to click.
 */
type EntityEmptyConfig = EntityPresentation["emptyState"];

const entityEmptyConfig = (entity: BrowserRoutedEntity): EntityEmptyConfig =>
  entityPresentation[entity].emptyState;

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
  if (isFiltered) {
    return <FilteredEmptyState onClearFilters={onClearFilters} />;
  }

  const config = entityEmptyConfig(entity);
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
