import type { BrowserRoutedEntity } from "@cubby/schemas/entity-manifest";
import {
  kernelActorLabel,
  kernelStageLabel,
  machineryColumnLabel,
  machineryCostLabel,
} from "@cubby/schemas/field-envelope-presentation";
import { machineryListFields } from "@cubby/schemas/kernel/machinery";
import type { UnitMapping } from "@cubby/schemas/unitmapping";
import { useQueryClient } from "@tanstack/react-query";
import type { CellData } from "@tanstack/react-table";
import type { ReactNode } from "react";
import { useCallback, useMemo, useRef } from "react";
import { z } from "zod";

import type { EntityActionSubject } from "~/entity/actions/entity-actions";
import {
  createEntityDisplayColumns,
  identitySecondLineFields,
  renderCompactFieldValue,
} from "~/entity/display/entity-display";
import { fieldOptions } from "~/entity/display/list-renderers/generic-state";
import { browserEntityDefinition, getSortableFields } from "~/entity/entities";
import { identityWidthClassName } from "~/entity/entity-list/identity-list-config";
import { readRecordField } from "~/entity/entity-references";
import { featureRegistry } from "~/entity/feature-registry";
import { manifestFilterConfig } from "~/entity/filter-manifest";
import { useEntityMetadata, listFieldPresentation } from "~/entity/metadata";
import { readPathValue } from "~/entity/read-path";
import {
  createActionsColumn,
  createImageColumn,
  isImageColumnId,
  createNameColumn,
  createTimestampColumn,
  multiSelectFilterFn,
  type RowLinkResolver,
} from "~/entity/table/column-helpers";
import type { RuntimeFilterOptions } from "~/ui/combobox/filter-option-types";
import { buildSelectColumn } from "~/ui/data-table/row-selection";
import {
  createCubbyColumnCollection,
  type CubbyColumnCollection,
  type CubbyColumnDef,
  type CubbyColumnHelper as ColumnHelper,
} from "~/ui/data-table/table-features";
import { type FilterConfig } from "~/ui/data-table/table-meta";
import { KindTag } from "~/ui/records/kind-tag";

/** Filter definition for use in useEntityList options */
interface FilterDef {
  id: string;
  placeholder: string;
  filterType?: "text" | "select" | "multiselect";
  options?: Array<{ value: string; label: string }>;
}

/** Simple filter definition - string expands to text filter with placeholder */
export type FilterInput = string | FilterDef;

function isFilterId(value: FilterInput): value is string {
  return typeof value === "string";
}

/** Base interface for entities in list views */
interface BaseListRow {
  id: string;
  name?: string | null;
  createdAt?: string | Date;
}

const titleValueSchema = z.string().nullish().catch(null);
const kindValueSchema = z.string().nullish().catch(null);

const labelSchema = z.string().min(1);
const labelText = <TRow extends object>(
  row: TRow,
  labelPath: string | null | undefined,
) =>
  labelPath
    ? (labelSchema.safeParse(readPathValue(row, labelPath)).data ?? null)
    : null;

const isEmptyValue = (value: unknown) =>
  value == null || value === "" || (Array.isArray(value) && value.length === 0);

interface UseStandardColumnsOptions<TData extends BaseListRow> {
  entity: BrowserRoutedEntity;
  /** Column helper instance (must be memoized) */
  columnHelper: ColumnHelper<TData>;
  /** Custom columns (inserted between standard columns) */
  customColumns: CubbyColumnCollection<TData>;
  /**
   * Fallback filter definitions for columns the manifest doesn't cover
   * (client-only tables, one-off embedded tables). Entities in
   * `entities/filter-manifest` should declare their filters there instead.
   */
  filters: FilterInput[];
  /**
   * Option lists for manifest specs that name an `optionsKey` — picklists
   * sourced from the server (the project roster, a recipe tag universe) that
   * can't be static module data. MUST be referentially stable (useMemo at the
   * page) or the columns memo churns every render.
   */
  filterOptions?: RuntimeFilterOptions;
  enableRowSelection: boolean;
  /** Combined extra actions renderer for row actions */
  combinedExtraActions?: (row: TData) => ReactNode;
  /** Unit mappings map (id -> mappings), null if not used */
  mappingsMap: Record<string, UnitMapping[]> | null;
  hasUnitMappings: boolean;
  /**
   * Width class for the standard name column. Defaults to auto (`min-w-0`).
   * Pass a fixed width (e.g. `w-64`) on sparse tables so the name doesn't
   * balloon to absorb all leftover space under the fixed table layout.
   */
  nameClassName?: string;
  /**
   * Enable inline editing on the standard name column. MUST be referentially
   * stable (memoized by the caller) — it feeds the columns useMemo below.
   */
  nameEditable?: {
    onSave: (newValue: string, row: TData) => Promise<void>;
    getValue?: (row: TData) => string | null;
  };
  /** Extra content rendered inline after the standard name column's name. */
  nameSuffix?: (row: TData) => ReactNode;
  namePrefix?: (row: TData) => ReactNode;
  /**
   * Render the tree expand/collapse affordance (chevron + depth indent) on the
   * standard name column. Forwarded to `createNameColumn`; inert when unset.
   * Only meaningful when the table wires `getSubRows`/`getExpandedRowModel`.
   */
  expandable?: boolean;
  /**
   * Per-row detail link for a table whose rows aren't all `entity` — a tree
   * whose children are a different entity than its parents (the wishlist's
   * candidate Products under a Wish). Applied to BOTH the name column and the
   * actions column's "View details", so they can't disagree. Defaults to
   * `entity`'s detail route keyed by `row.id`.
   */
  rowLink?: RowLinkResolver<TData>;
  subject?: (row: TData) => EntityActionSubject | null;
  /**
   * Column ids to render with NO filter control, even though the manifest (or
   * a column factory's own fallback) declares one. For a page that pins that
   * column's value via `useEntityList`'s contextual `scopeFilters` — which spreads OVER
   * the manifest-derived filters, so it silently wins — the header control
   * would otherwise be interactive but inert: the user picks a value, the
   * page-level scope clobbers it. E.g. the cookbook detail page's embedded
   * `RecipeList` pins `cookbookId` and hides the Source column's control.
   * May be a fresh array literal each render — internally stabilized like
   * `filters`.
   */
  hiddenFilterColumns?: string[];
}

const mappingsColumnId = (entity: string) =>
  entity === "product" ? "unitMappingQuality" : "unitMappings";

function columnIdentifier<TData extends BaseListRow, TValue extends CellData>(
  column: CubbyColumnDef<TData, TValue>,
): string | null {
  if (column.id) return column.id;
  if ("accessorKey" in column && column.accessorKey != null) {
    return String(column.accessorKey);
  }
  return null;
}

/**
 * Hook for building standard columns array for entity list tables.
 *
 * Handles:
 * - Select column (if row selection enabled)
 * - Standard identity columns (image/name) plus shared Created/Updated dates
 * - Custom columns with auto-sorting based on sortable fields
 * - Unit mappings column
 * - Actions column (always last)
 */
export function useStandardColumns<TData extends BaseListRow>({
  entity,
  columnHelper,
  customColumns,
  filters,
  filterOptions,
  enableRowSelection,
  combinedExtraActions,
  rowLink,
  subject,
  mappingsMap,
  hasUnitMappings,
  nameClassName,
  nameEditable,
  nameSuffix,
  namePrefix,
  expandable,
  hiddenFilterColumns,
}: UseStandardColumnsOptions<TData>): CubbyColumnCollection<TData> {
  // Stabilize filters array - only update when serialized content changes
  // This prevents re-renders when consumer passes new array literal each render
  const queryClient = useQueryClient();
  const metadata = useEntityMetadata(entity);
  const filtersKey = JSON.stringify(filters);
  const stableFilters = useMemo(
    () => filters,
    // oxlint-disable-next-line react/exhaustive-deps -- filtersKey is the intentional deep-comparison trigger.
    [filtersKey],
  );

  // Same stabilization for the (much rarer) hidden-columns opt-out.
  const hiddenFilterColumnsKey = JSON.stringify(hiddenFilterColumns ?? []);
  const hiddenFilterColumnSet = useMemo(
    () => new Set(hiddenFilterColumns ?? []),
    // oxlint-disable-next-line react/exhaustive-deps -- intentional - using hiddenFilterColumnsKey for deep comparison
    [hiddenFilterColumnsKey],
  );

  // Memoize entity config to prevent re-renders when entity doesn't change
  const { standardColumns, shouldUseMappings, titleField } = useMemo(() => {
    const listConfig = browserEntityDefinition(entity).list;
    const resolvedTitleField = metadata.summary.titleField;
    const standardColumns = metadata.fields.fields.filter(
      (field) => field.display.list && field.display.standard,
    );
    const listHasUnitMappings = listConfig?.hasUnitMappings ?? false;
    return {
      standardColumns,
      shouldUseMappings: listHasUnitMappings && hasUnitMappings,
      titleField: resolvedTitleField,
    };
  }, [entity, hasUnitMappings, metadata]);
  const identityWidth = useMemo(() => {
    const titleFieldModel = metadata.fields.fields.find(
      (field) => field.key === titleField,
    );
    return identityWidthClassName(titleFieldModel?.display.width ?? null);
  }, [titleField, metadata]);

  // Build columns array with standard columns - memoized to prevent infinite re-renders
  // The map grows with every page and enrichment arrival; keying columns on
  // it rebuilt them all and remounted every cell. Cells look rows up through a
  // stable function instead, and only the column's presence keys the memo.
  const latestMappings = useRef(mappingsMap);
  latestMappings.current = mappingsMap;
  const mappingsFor = useCallback(
    (id: string) => latestMappings.current?.[id],
    [],
  );
  const hasMappings = mappingsMap !== null;
  // The title cell's declared kind tag and second line, read per row.
  const identityLines = useMemo(() => {
    const kind = metadata.summary.kind;
    const kindOptions = kind
      ? fieldOptions(queryClient, entity, kind.field)
      : [];
    const lineFields = identitySecondLineFields(queryClient, entity).flatMap(
      (key) => metadata.fields.fields.filter((field) => field.key === key),
    );
    return {
      kindTag: kind
        ? (row: TData) => {
            const value = readRecordField(row, kind.field, kindValueSchema);
            const option = kindOptions.find(
              (candidate) => candidate.value === value,
            );
            return option ? <KindTag option={option} /> : null;
          }
        : undefined,
      secondLine:
        lineFields.length > 0
          ? (row: TData) =>
              lineFields.flatMap((field) =>
                isEmptyValue(readPathValue(row, field.readKey ?? field.key))
                  ? []
                  : [
                      {
                        key: field.key,
                        // A structured line (the Run's Why) reads as its
                        // declared label, not its JSON.
                        node:
                          labelText(row, field.display.labelPath) ??
                          renderCompactFieldValue(
                            queryClient,
                            entity,
                            row,
                            field,
                            { singleLine: true },
                          ),
                      },
                    ],
              )
          : undefined,
    };
  }, [entity, metadata, queryClient]);
  // Paging can replace action resolvers without changing the name editor.
  // Its component function owns the draft, so give it its own lifetime.
  const identityDefinition = useMemo(
    () =>
      createNameColumn(columnHelper, entity, undefined, {
        id: titleField,
        header: metadata.summary.singular,
        enableSorting: getSortableFields(queryClient, entity).includes(
          titleField,
        ),
        className: nameClassName ?? identityWidth,
        // Computed titles stay read-only unless an explicit adapter maps the
        // edit gesture to an underlying stored field (for example, Meal name).
        editable: nameEditable,
        nameSuffix,
        namePrefix,
        expandable,
        rowLink,
        kindTag: identityLines.kindTag,
        secondLine: identityLines.secondLine,
        getValue: (row: TData) =>
          readRecordField(row, titleField, titleValueSchema) ?? null,
      }),
    [
      columnHelper,
      entity,
      titleField,
      metadata.summary.singular,
      queryClient,
      nameClassName,
      identityWidth,
      nameEditable,
      nameSuffix,
      namePrefix,
      expandable,
      rowLink,
      identityLines,
    ],
  );
  // Related/custom metadata can also change the collection. Standard renderers
  // depend only on their own behavior, never on that collection's identity.
  const standardDefinitions = useMemo(() => {
    const imageField = standardColumns.find(
      (field) => field.display.standard === "image",
    );
    const mappingsId = mappingsColumnId(entity);
    return {
      image: createImageColumn(columnHelper, {
        entity,
        explanation: imageField?.explanation
          ? { entity, field: imageField.key, label: imageField.label }
          : undefined,

        provenance: imageField?.provenance ?? null,
      }),
      quality: createEntityDisplayColumns(
        queryClient,
        entity,
        columnHelper,
        undefined,
        {
          only: ["dataQuality"],
        },
      ),
      mappings:
        shouldUseMappings && hasMappings
          ? featureRegistry().components.createUnitMappingsColumn(
              columnHelper,
              mappingsFor,
              {
                id: mappingsId,
                enableSorting: false,
              },
            )
          : null,
      createdAt: createTimestampColumn(columnHelper, "createdAt"),
      updatedAt: createTimestampColumn(columnHelper, "updatedAt"),
      actions: createActionsColumn(columnHelper, entity, {
        extraActions: combinedExtraActions,
        rowLink,
        subject,
        quick: metadata.summary.list.quickActions.length > 0,
      }),
    };
  }, [
    columnHelper,
    entity,
    standardColumns,
    shouldUseMappings,
    hasMappings,
    mappingsFor,
    combinedExtraActions,
    rowLink,
    subject,
    queryClient,
    metadata,
  ]);
  const baseColumns = useMemo(
    () =>
      createCubbyColumnCollection<TData>((add) => {
        // The filter manifest is the source of truth for what a column can be
        // filtered by; a page-supplied `filters` entry is the fallback for columns
        // (and client-only tables) the manifest doesn't cover.
        const getFilterConfig = (
          columnId: string,
        ): FilterConfig | undefined => {
          if (hiddenFilterColumnSet.has(columnId)) return undefined;

          const fromManifest = manifestFilterConfig(
            queryClient,
            entity,
            columnId,
          );
          if (fromManifest) return fromManifest;

          const filterDef = stableFilters.find((filter) =>
            isFilterId(filter) ? filter === columnId : filter.id === columnId,
          );
          if (!filterDef) return undefined;
          if (isFilterId(filterDef)) {
            return { placeholder: `Filter by ${filterDef}...` };
          }
          return {
            placeholder: filterDef.placeholder,
            filterType: filterDef.filterType,
            options: filterDef.options,
          };
        };

        /**
         * Overlay the manifest's filter control onto one column def.
         *
         * Applies to the columns this hook APPENDS (image, unit mappings) as well
         * as the caller's own — they're real, filterable columns, and a manifest
         * spec pointing at one used to render nothing at all, silently, because
         * only the caller's columns went through the overlay.
         */
        const withManifestFilter = <TValue extends CellData>(
          col: CubbyColumnDef<TData, TValue>,
          colId: string,
        ): CubbyColumnDef<TData, TValue> => {
          const manifestConfig = getFilterConfig(colId);
          const nextColumn = {
            ...col,
            // Client-side tables would otherwise resolve a filterFn from the ROW
            // value's type and silently match nothing against an array. Harmless
            // on server-filtered tables, which never run it.
            meta: {
              ...col.meta,
              presentation: listFieldPresentation(queryClient, entity, colId),
              ...(manifestConfig ? { filterConfig: manifestConfig } : {}),
            },
          };
          if (manifestConfig?.filterType === "multiselect") {
            nextColumn.filterFn = multiSelectFilterFn;
          }
          return nextColumn;
        };

        // Prepend select column if row selection is enabled
        if (enableRowSelection) {
          add(buildSelectColumn<TData>());
        }

        const hasExplicitImageColumn = customColumns
          .visit((column) => isImageColumnId(columnIdentifier(column)))
          .some(Boolean);
        if (!hasExplicitImageColumn) {
          add(withManifestFilter(standardDefinitions.image, "image"));
        }
        add(withManifestFilter(identityDefinition, titleField));
        add(
          withManifestFilter(
            columnHelper.accessor(
              (row) => {
                const read = machineryListFields.safeParse(
                  readPathValue(row, "machinery"),
                );
                return read.success ? read.data.stage : null;
              },
              {
                id: "machineryStage",
                header: "Stage",
                enableSorting: true,
                meta: {
                  className: "w-52",
                  mobile: { slot: "meta", priority: 10 },
                },
                cell: ({ row }) => {
                  const read = machineryListFields.safeParse(
                    readPathValue(row.original, "machinery"),
                  );
                  if (!read.success) return null;
                  const work = read.data;
                  return (
                    <span
                      className="break-words whitespace-normal"
                      title={work.firstGap ?? undefined}
                    >
                      {kernelStageLabel(work.stage)}
                      {work.nextActor
                        ? ` · ${kernelActorLabel(work.nextActor)}`
                        : ""}
                      {work.firstGap
                        ? ` · ${work.firstGap.split(/\s+/).slice(0, 6).join(" ")}`
                        : ""}
                    </span>
                  );
                },
              },
            ),
            "machineryStage",
          ),
        );

        for (const key of [
          "gap",
          "actor",
          "attempts",
          "cost",
          "eta",
        ] as const) {
          const id =
            key === "actor"
              ? "machineryActor"
              : `machinery${key[0]?.toUpperCase()}${key.slice(1)}`;
          add(
            withManifestFilter(
              columnHelper.accessor(
                (row) => {
                  const read = machineryListFields.safeParse(
                    readPathValue(row, "machinery"),
                  );
                  if (!read.success) return null;
                  const work = read.data;
                  return key === "actor"
                    ? work.nextActor
                    : key === "gap"
                      ? work.firstGap
                      : key === "attempts"
                        ? work.attempts
                        : key === "cost"
                          ? work.costMicros
                          : work.eta;
                },
                {
                  id,
                  header: machineryColumnLabel(key),
                  enableSorting: key === "actor",
                  meta: { className: "w-40" },
                  cell: ({ row }) => {
                    const read = machineryListFields.safeParse(
                      readPathValue(row.original, "machinery"),
                    );
                    if (!read.success) return null;
                    const work = read.data;
                    const value =
                      key === "gap"
                        ? work.firstGap
                        : key === "actor"
                          ? work.nextActor
                            ? kernelActorLabel(work.nextActor)
                            : null
                          : key === "attempts"
                            ? String(work.attempts)
                            : key === "cost"
                              ? machineryCostLabel(work.costMicros)
                              : work.nextActor === "cubby" ||
                                  work.nextActor === "agent" ||
                                  work.nextActor === "time"
                                ? (work.eta ?? "ETA unknown")
                                : null;
                    return (
                      <span className="break-words whitespace-normal tabular-nums">
                        {value ?? "—"}
                      </span>
                    );
                  },
                },
              ),
              id,
            ),
          );
        }

        // Custom columns get two things applied from the registries: sorting from
        // `sortableFields`, and their filter control from the manifest.
        const sortableFields = getSortableFields(queryClient, entity);
        if (
          !customColumns
            .visit((column) => columnIdentifier(column) === "dataQuality")
            .some(Boolean)
        ) {
          standardDefinitions.quality.visit(add);
        }

        customColumns
          // Audit timestamps have one canonical position: after every domain and
          // related column, immediately before Actions. A few older custom tables
          // supplied Created in the middle; drop that copy before appending the
          // shared pair below.
          .filter((col) => {
            const colId = columnIdentifier(col);
            return colId !== "createdAt" && colId !== "updatedAt";
          })
          .visit((col) => {
            const colId = columnIdentifier(col);

            // Auto-disable sorting for columns not in sortableFields; an explicit
            // enableSorting on the column def still wins.
            const enableSorting =
              col.enableSorting !== undefined
                ? col.enableSorting
                : colId
                  ? sortableFields.includes(colId)
                  : false;

            // Manifest config overlays whatever the column factory baked in. The
            // factories' own `filterConfig` (e.g. createFilterableSelectColumn
            // deriving one from its editor options) stays as the fallback for
            // columns and tables the manifest doesn't cover.
            const withSorting = {
              ...col,
              enableSorting,
              meta: {
                ...col.meta,
                entityColumnRole: col.meta?.entityColumnRole ?? "fact",
              },
            };
            add(colId ? withManifestFilter(withSorting, colId) : withSorting);
          });

        if (standardDefinitions.mappings) {
          // The product id stays "unitMappingQuality" — it's what the manifest's
          // presence filter hangs on. NOT sortable: the cell grades conversion
          // COVERAGE (a graph reachability run through the unit engine, over
          // USDA-derived edges the server never loads), which no SQL ORDER BY can
          // reproduce. The old sort ordered by an edge-count proxy instead, i.e.
          // by a quantity that isn't on screen.
          const mappingsColId = mappingsColumnId(entity);
          add(withManifestFilter(standardDefinitions.mappings, mappingsColId));
        }

        // Top-level lists reveal the audit pair by default; embedded lists keep
        // it available through the column visibility controls.
        add(standardDefinitions.createdAt);
        add(standardDefinitions.updatedAt);

        add(standardDefinitions.actions);
      }),
    [
      columnHelper,
      customColumns,
      entity,
      standardDefinitions,
      identityDefinition,
      titleField,
      stableFilters,
      enableRowSelection,
      hiddenFilterColumnSet,
      queryClient,
    ],
  );

  // Runtime filter rosters change independently of cell editors. Overlay their
  // metadata without rebuilding the component functions that own open drafts.
  return useMemo(
    () =>
      createCubbyColumnCollection<TData>((add) => {
        baseColumns.visit((column) => {
          const id = columnIdentifier(column);
          const filterConfig =
            id && !hiddenFilterColumnSet.has(id)
              ? manifestFilterConfig(queryClient, entity, id, filterOptions)
              : undefined;
          add(
            filterConfig
              ? { ...column, meta: { ...column.meta, filterConfig } }
              : column,
          );
        });
      }),
    [baseColumns, entity, filterOptions, hiddenFilterColumnSet, queryClient],
  );
}
