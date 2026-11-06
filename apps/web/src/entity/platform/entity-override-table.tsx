import type { Entity } from "@cubby/schemas/entity";
import { allEntities } from "@cubby/schemas/entity-roster";
import { useSuspenseQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import RTable from "~/entity/table/table";
import {
  createCubbyColumnCollection,
  createCubbyColumnHelper,
} from "~/ui/data-table/table-features";
import { attachCubbyColumnMeta } from "~/ui/data-table/table-meta";
import { useLocalTable } from "~/ui/data-table/use-local-table";
import { QuerySection } from "~/ui/feedback/query-section";

import type { OverrideRow } from "./entity-schema-model";
import { schemaOverridesQueryOptions } from "./schema-presentation";

const helper = createCubbyColumnHelper<OverrideRow>();
const rowId = (row: OverrideRow) => `${row.entity}.${row.path}`;
const search = {
  text: (row: OverrideRow) =>
    [row.entity, row.path, row.declared, row.without, row.reason].join(" "),
  placeholder: "Search entity, path, or value",
};
/** Required inputs fail compilation when removed; changed inputs alter a default. */
const OUTCOME_LABEL = {
  invalid: "Required",
  changed: "Changes default",
} as const;
const familyOf = (path: string) => path.replace(/\[[^\]]*\]/gu, "[*]");
const columnsFor = (families: readonly string[]) =>
  createCubbyColumnCollection<OverrideRow>((add) => {
    add(
      helper.accessor("entity", {
        header: "Entity",
        size: 160,
        meta: attachCubbyColumnMeta<OverrideRow>({
          mobile: { slot: "title", priority: 0 },
          filterConfig: {
            filterType: "select",
            placeholder: "Filter entity",
            options: allEntities.map((entity) => ({
              value: entity,
              label: entity,
            })),
            facetCount: true,
          },
        }),
        filterFn: "equals",
      }),
    );
    add(
      helper.accessor("path", {
        header: "Override path",
        size: 280,
        meta: attachCubbyColumnMeta<OverrideRow>({
          mono: true,
          mobile: { slot: "subtitle", priority: 0 },
          filterConfig: {
            label: "Override type",
            filterType: "select",
            placeholder: "Filter override type",
            options: families.map((family) => ({
              value: family,
              label: family,
            })),
          },
        }),
        filterFn: (row, _id, value) => familyOf(row.original.path) === value,
      }),
    );
    add(
      helper.accessor("declared", {
        header: "Declared",
        size: 260,
        meta: attachCubbyColumnMeta<OverrideRow>({
          mono: true,
          mobile: { slot: "meta", priority: 1 },
        }),
      }),
    );
    add(
      helper.accessor((row) => row.without ?? row.reason ?? "No valid value", {
        id: "without",
        header: "Without override",
        size: 260,
        meta: attachCubbyColumnMeta<OverrideRow>({
          mobile: { slot: "meta", priority: 2 },
        }),
      }),
    );
    add(
      helper.accessor("status", {
        header: "Outcome",
        size: 160,
        meta: attachCubbyColumnMeta<OverrideRow>({
          mobile: { slot: "trailing", priority: 0 },
          filterConfig: {
            filterType: "select",
            placeholder: "Filter outcome",
            options: Object.entries(OUTCOME_LABEL).map(([value, label]) => ({
              value,
              label,
            })),
            facetCount: true,
          },
        }),
        filterFn: "equals",
        cell: ({ row }) => OUTCOME_LABEL[row.original.status],
      }),
    );
  });

/** Declaration comparisons share filtering, sorting, layout, and phone rows. */
function OverrideTable({
  onSelectEntity,
}: {
  onSelectEntity: (entity: Entity) => void;
}) {
  const { data: rows } = useSuspenseQuery(schemaOverridesQueryOptions());
  const columns = useMemo(
    () =>
      columnsFor([...new Set(rows.map((row) => familyOf(row.path)))].sort()),
    [rows],
  );
  const table = useLocalTable({ rows, columns, getRowId: rowId, search });
  return (
    <RTable
      table={table}
      embedded
      ariaLabel="Declaration overrides"
      withoutImages="Declaration overrides are schema metadata, not household records."
      onRowClick={(row) => onSelectEntity(row.original.entity)}
      disableMobileDetailsHref
    />
  );
}

export function EntityOverrideTable(props: {
  onSelectEntity: (entity: Entity) => void;
}) {
  return (
    <QuerySection title="Declaration overrides" fallback={null}>
      <OverrideTable {...props} />
    </QuerySection>
  );
}
