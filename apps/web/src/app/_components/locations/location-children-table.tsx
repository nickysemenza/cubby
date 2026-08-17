/**
 * The Table-view rendering of a location's sub-locations: one row per
 * descendant, twirling down through every level in a single fetch.
 *
 * The Shelf view's card grid stops at the location's direct children — a
 * packout stack shows "4 drawer packout · 4 locs" and the drawers themselves
 * are a page away. This surface trades the photos for depth.
 */

import type { LocationShortcode } from "@cubby/schemas/identifiers";
import type { InfLocation } from "@cubby/schemas/location";
import { useQuery } from "@tanstack/react-query";
import { createColumnHelper } from "@tanstack/react-table";
import { ChevronsDownUp, ChevronsUpDown } from "lucide-react";
import { useEffect, useMemo } from "react";
import { Button } from "~/components/ui/button";
import { NoneValue } from "~/components/ui/none-value";
import { useTRPC } from "~/integrations/trpc/react";
import { formatCurrency } from "~/lib/utils";
import {
  createFilterableSelectColumn,
  createImageColumn,
  createNameColumn,
  createSingleEntityInlineLinkColumn,
} from "../data-table/columnHelpers";
import RTable from "../data-table/Table";
import { useClientEntityList } from "../hooks/useClientEntityList";
import { LocationTypeLabel } from "./LocationTypeLabel";
import { locationTypeOptionsWithTheme } from "./location-icons";

/**
 * `subRows` rather than reusing `children`: `useClientEntityList` walks
 * `subRows` to collect ids for its related-preview columns, so a tree keyed on
 * anything else loses those columns below the first level.
 */
type LocationTreeRow = InfLocation & { subRows: LocationTreeRow[] };

/** Stable hook configs (see apps/web/CLAUDE.md on inline objects). */
const EMBEDDED_TABLE_STATE = {
  urlSync: false,
  readUrlState: false,
} as const;
const NO_LOCATIONS: InfLocation[] = [];
const TREE_CONFIG = {
  getSubRows: (row: LocationTreeRow) => row.subRows,
  // A deep name match keeps its ancestors visible, so filtering never hides
  // the path to the row it matched.
  filterFromLeafRows: true,
  // Page size counts top-level children only — expanding a row must not push
  // its siblings onto the next page.
  paginateExpandedRows: false,
  autoResetExpanded: false,
} as const;

const toRows = (nodes: InfLocation[]): LocationTreeRow[] =>
  nodes.map((node) => ({ ...node, subRows: toRows(node.children ?? []) }));

export function LocationChildrenTable({
  locationId,
}: {
  locationId: LocationShortcode;
}) {
  const api = useTRPC();
  const helper = useMemo(() => createColumnHelper<LocationTreeRow>(), []);

  const {
    data = NO_LOCATIONS,
    isLoading,
    error,
  } = useQuery(api.location.subtree.queryOptions({ shortcode: locationId }));

  const rows = useMemo(() => toRows(data), [data]);

  const columns = useMemo(
    () => [
      // `location` declares `standardColumns: []` (entities.tsx), so image and
      // name are the table's own — which is also why the expand chevron is set
      // here rather than via the tree config's `expandable`.
      createImageColumn(helper, { entity: "location" }),
      createNameColumn(helper, "location", "name", {
        expandable: true,
        filterConfig: { placeholder: "Filter by location name..." },
        mobile: { slot: "title", priority: 0 },
      }),
      createFilterableSelectColumn(helper, "type", {
        header: "Type",
        className: "w-32",
        placeholder: "Filter by type...",
        selectOptions: locationTypeOptionsWithTheme,
        // Renders empty for a product-linked child — the "Is a" column beside
        // it carries that identity, same split as the locations list.
        renderCell: (type) => <LocationTypeLabel type={type} product={null} />,
        mobile: { slot: "subtitle", priority: 15 },
      }),
      createSingleEntityInlineLinkColumn(helper, "product", "product", {
        header: "Is a",
        className: "w-48",
        mobile: { slot: "meta", priority: 40 },
      }),
      helper.accessor(
        (row) => row.valuation?.totalItemCount ?? row.totalItemCount ?? 0,
        {
          id: "items",
          header: "Items",
          meta: {
            className: "w-20",
            numeric: true,
            mobile: { slot: "meta", priority: 30 },
          },
          cell: (info) =>
            info.getValue() === 0 ? <NoneValue /> : info.getValue(),
        },
      ),
      helper.accessor((row) => row.childCount ?? 0, {
        id: "locs",
        header: "Locs",
        meta: {
          className: "w-20",
          numeric: true,
          mobile: { slot: "meta", priority: 40 },
        },
        cell: (info) =>
          info.getValue() === 0 ? <NoneValue /> : info.getValue(),
      }),
      // Total, not direct — it's the number the shelf card's caption shows, and
      // on a parent row the subtree total is the useful one.
      helper.accessor((row) => row.valuation?.totalValuation ?? 0, {
        id: "valuation",
        header: "Value",
        meta: {
          className: "w-28",
          numeric: true,
          mobile: { slot: "trailing", priority: 10 },
        },
        cell: (info) =>
          info.getValue() === 0 ? (
            <NoneValue />
          ) : (
            formatCurrency(info.getValue())
          ),
      }),
    ],
    [helper],
  );

  const { table, bulkActionBar } = useClientEntityList<LocationTreeRow>({
    entity: "location",
    data: rows,
    columns,
    tree: TREE_CONFIG,
    // One URL writer per page — the detail page's other embedded table does the
    // same (see location-inventory-table).
    tableStateOptions: EMBEDDED_TABLE_STATE,
    // Distinct column set from the /locations index, so it needs its own
    // persisted View settings rather than sharing `table-columns:location`.
    columnVisibilityScope: "location-contents",
  });

  // Reveal deep matches while filtering by name, then collapse back — the
  // projects WBS tree does the same.
  const searching = Boolean(table.getColumn("name")?.getFilterValue());
  // biome-ignore lint/correctness/useExhaustiveDependencies: table identity churns every render; the toggle is keyed on `searching`
  useEffect(() => {
    table.toggleAllRowsExpanded(searching);
  }, [searching]);

  const allExpanded = table.getIsAllRowsExpanded();

  return (
    <RTable
      table={table}
      isLoading={isLoading}
      error={error}
      ariaLabel="Sub-locations"
      entity="location"
      sizingKey="location:contents"
      bulkActionBar={bulkActionBar}
      embedded
      actions={
        table.getCanSomeRowsExpand() ? (
          <Button
            variant="outline"
            size="sm"
            onClick={() => table.toggleAllRowsExpanded()}
          >
            {allExpanded ? <ChevronsDownUp /> : <ChevronsUpDown />}
            {allExpanded ? "Collapse all" : "Expand all"}
          </Button>
        ) : null
      }
    />
  );
}
