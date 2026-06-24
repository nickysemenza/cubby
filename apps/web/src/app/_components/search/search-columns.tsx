import type { SearchableEntity, SearchResultItem } from "@cubby/schemas/search";
import { createColumnHelper } from "@tanstack/react-table";
import { Row } from "~/components/layout";
import { Description } from "~/components/ui/description";
import { EntityIcon, entities } from "~/entities/entities";
import {
  createActionsColumnBase,
  createCreatedAtColumn,
  createImageColumn,
} from "../data-table/columnHelpers";
import { NoneState } from "../NoneState";
import {
  entityTypeMap,
  getEnrichmentText,
  SearchResultItemIcon,
} from "./search-utils";

const columnHelper = createColumnHelper<SearchResultItem>();

/** Options for entity type filter dropdown */
const entityTypeOptions: Array<{
  value: SearchableEntity | "";
  label: string;
}> = [
  { value: "", label: "All types" },
  { value: "product", label: "Product" },
  { value: "recipe", label: "Recipe" },
  { value: "ingredient", label: "Ingredient" },
  { value: "location", label: "Location" },
  { value: "inventory", label: "Inventory" },
];

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
        options: entityTypeOptions.map((opt) => ({
          value: opt.value,
          label: opt.label,
        })),
      },
    },
    cell: ({ row }) => {
      const entity = entityTypeMap[row.original.entityType];
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
        <NoneState />
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
        <NoneState />
      );
    },
  }),

  // Created - use helper
  createCreatedAtColumn(columnHelper),

  // Actions - polymorphic (entity varies per row)
  createActionsColumnBase(columnHelper, (row) => ({
    to: entities[entityTypeMap[row.entityType]].routes.detail,
    params: { id: row.id },
  })),
];
