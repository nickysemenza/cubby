import type { SearchableEntity, SearchResultItem } from "@cubby/schemas/search";
import { searchableEntities } from "@cubby/schemas/search";
import { createColumnHelper } from "@tanstack/react-table";
import { Row } from "~/components/layout";
import { Description } from "~/components/ui/description";
import { NoneValue } from "~/components/ui/none-value";
import { EntityIcon, entities } from "~/entities/entities";
import {
  createActionsColumnBase,
  createCreatedAtColumn,
  createImageColumn,
} from "../data-table/columnHelpers";
import {
  entityTypeMap,
  getEnrichmentText,
  getSearchMatchText,
  getSearchResultEntity,
  getSearchResultRoute,
  SearchResultItemIcon,
} from "./search-utils";

const columnHelper = createColumnHelper<SearchResultItem>();

/**
 * Options for the entity type filter dropdown, derived from the searchable
 * roster so a newly-searchable entity can't silently go missing from the filter.
 */
const entityTypeOptions: Array<{
  value: SearchableEntity;
  label: string;
}> = searchableEntities.map((entityType) => ({
  value: entityType,
  label: entities[entityTypeMap[entityType]].label,
}));

export const searchColumns = [
  // Image - compact thumbnail
  createImageColumn(columnHelper, {
    entity: "product",
    getImages: (row) =>
      row.imageUrl ? [{ id: row.id, url: row.imageUrl }] : [],
    className: "w-12",
  }),

  // Name with type-specific icon (custom - can't use createNameColumn since entity varies per row)
  columnHelper.accessor("name", {
    header: "Name",
    enableSorting: true,
    meta: { className: "min-w-0 w-40 max-w-56" },
    cell: ({ row }) => (
      <Row align="center" gap="sm">
        <SearchResultItemIcon item={row.original} />
        <span className="truncate font-medium">{row.original.name}</span>
      </Row>
    ),
  }),

  // Entity type with select filter
  columnHelper.accessor("entityType", {
    header: "Type",
    enableSorting: true,
    meta: {
      className: "w-28",
      filterConfig: {
        filterType: "select",
        placeholder: "All types",
        options: entityTypeOptions,
      },
    },
    cell: ({ row }) => {
      const entity = getSearchResultEntity(row.original);
      const entityDef = entities[entity];
      return (
        <span className="inline-flex items-center gap-2">
          <EntityIcon entity={entity} size={10} colored />
          {entityDef.label}
        </span>
      );
    },
  }),

  // Info (subtitle)
  columnHelper.accessor("subtitle", {
    header: "Info",
    enableSorting: false,
    meta: { className: "w-32" },
    cell: ({ getValue }) => {
      const value = getValue();
      return value ? (
        <Description as="span">{value}</Description>
      ) : (
        <NoneValue />
      );
    },
  }),

  // Details (enrichment)
  columnHelper.display({
    id: "details",
    header: "Details",
    meta: { className: "w-28" },
    cell: ({ row }) => {
      const enrichment = getEnrichmentText(row.original);
      return enrichment ? (
        <Description as="span" size="xs">
          {enrichment}
        </Description>
      ) : (
        <NoneValue />
      );
    },
  }),

  columnHelper.display({
    id: "match",
    header: "Match",
    meta: { className: "w-40" },
    cell: ({ row }) => {
      const matchText = getSearchMatchText(row.original);
      return matchText ? (
        <Description as="span" size="xs" title={row.original.matchReason}>
          {matchText}
        </Description>
      ) : (
        <NoneValue />
      );
    },
  }),

  // Created - use helper
  createCreatedAtColumn(columnHelper),

  // Actions - polymorphic (entity varies per row)
  createActionsColumnBase(columnHelper, getSearchResultRoute),
];
