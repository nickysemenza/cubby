import type { SearchableEntity, SearchResultItem } from "@cubby/schemas/search";
import { searchableEntities } from "@cubby/schemas/search";
import { createColumnHelper } from "@tanstack/react-table";
import { Row } from "~/components/layout";
import { Description } from "~/components/ui/description";
import { NoneValue } from "~/components/ui/none-value";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "~/components/ui/tooltip";
import { EntityIcon, entities } from "~/entities/entities";
import {
  createActionsColumnBase,
  createCreatedAtColumn,
  createImageColumn,
} from "../data-table/columnHelpers";
import { TableLink } from "../table/TableLink";
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

  // Name with type-specific icon. Can't use `createNameColumn` — it takes one
  // `Entity` for the whole column and search rows are polymorphic — but it
  // still owes the same contract as every other name cell: linked to the
  // detail route, and the full name reachable on hover (apps/web/CLAUDE.md,
  // "entity names are always readable and always clickable").
  columnHelper.accessor("name", {
    header: "Name",
    enableSorting: true,
    // A share of the table's width, not a fixed size (surplus is distributed
    // proportionally) — the widest column, because the name is what you scan.
    meta: { className: "min-w-0 w-80" },
    cell: ({ row }) => (
      <Row align="center" gap="sm">
        <SearchResultItemIcon item={row.original} />
        <Tooltip>
          <TooltipTrigger render={<span className="block min-w-0 truncate" />}>
            <TableLink {...getSearchResultRoute(row.original)}>
              {row.original.name}
            </TableLink>
          </TooltipTrigger>
          <TooltipContent side="top" className="max-w-xs">
            {row.original.name}
          </TooltipContent>
        </Tooltip>
      </Row>
    ),
  }),

  // Entity type with select filter
  columnHelper.accessor("entityType", {
    header: "Type",
    enableSorting: true,
    meta: {
      // Wide enough for the longest entity label ("Inventory Item") plus its
      // icon — at w-28 it clipped mid-word on every inventory row.
      className: "w-36",
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
    meta: { className: "w-44" },
    cell: ({ getValue }) => {
      const value = getValue();
      return value ? (
        <Description as="span" className="block truncate" title={value}>
          {value}
        </Description>
      ) : (
        <NoneValue />
      );
    },
  }),

  // Details (enrichment)
  columnHelper.display({
    id: "details",
    header: "Details",
    meta: { className: "w-40" },
    cell: ({ row }) => {
      const enrichment = getEnrichmentText(row.original);
      return enrichment ? (
        <Description
          as="span"
          size="xs"
          className="block truncate"
          title={enrichment}
        >
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
    meta: { className: "w-48" },
    cell: ({ row }) => {
      const matchText = getSearchMatchText(row.original);
      // Title the visible text, not `matchReason` — that's undefined on most
      // rows (it's only appended when there are no matchTerms), so the widest,
      // most-likely-to-clip cell had no tooltip at all.
      const reason = row.original.matchReason;
      return matchText ? (
        <Description
          as="span"
          size="xs"
          className="block truncate"
          title={
            reason && !matchText.includes(reason)
              ? `${matchText} · ${reason}`
              : matchText
          }
        >
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
