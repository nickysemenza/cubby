import type { Entity } from "@cubby/schemas/entity";
import { allEntities } from "@cubby/schemas/entity-roster";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { type ReactNode, useMemo } from "react";

import { EntityIcon } from "~/entity/entities";
import type { EntityInspectorHealth } from "~/entity/entity-inspector-health";
import RTable from "~/entity/table/table";
import { entityInspectorHealth } from "~/integrations/tanstack-query/domains/entityInspectorHealth";
import { authClient } from "~/lib/auth-client";
import { cn } from "~/lib/utils";
import {
  createCubbyColumnCollection,
  createCubbyColumnHelper,
} from "~/ui/data-table/table-features";
import { attachCubbyColumnMeta } from "~/ui/data-table/table-meta";
import { useLocalTable } from "~/ui/data-table/use-local-table";
import { QuerySection } from "~/ui/feedback/query-section";
import { domainWayfinding } from "~/ui/navigation/domain-wayfinding";
import { Badge } from "~/ui/primitives/badge";
import { StaticTable } from "~/ui/primitives/static-table";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/ui/primitives/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/ui/primitives/tabs";

import { EntityOverrideTable } from "./entity-override-table";
import { EntityReferenceGraph } from "./entity-reference-graph";
import { EntitySchemaPanel } from "./entity-schema-inspector";
import {
  CRUD_SLOTS,
  RELATION_STATUS_LEGEND,
  type SchemaRow,
  type SchemaOverview,
  relationStatusClass,
} from "./entity-schema-model";
import { schemaOverviewQueryOptions } from "./schema-presentation";
import { type SchemaSheet, schemaSheetSchema } from "./schema-sheet";

const dash = <span className="text-muted-foreground/40">—</span>;

// Gridlines on every cell; `border-separate` keeps them attached to sticky
// header and pinned cells, which `border-collapse` would leave behind.
const gridCell =
  "h-7 border-r border-b border-border/70 px-2 whitespace-nowrap";
const gridHead =
  "border-r border-b border-border bg-muted px-2 text-2xs font-medium text-muted-foreground whitespace-nowrap";

function Num({ value }: { value: number | undefined }) {
  if (value === undefined) return dash;
  return (
    <span className={value === 0 ? "text-muted-foreground/40" : undefined}>
      {value}
    </span>
  );
}

/** A spreadsheet boolean: a solid mark for yes, an empty cell for no. */
function Mark({ value, tone }: { value: boolean; tone?: string }) {
  return (
    <>
      {value && (
        <span
          aria-hidden
          className={cn(
            "inline-block size-1.5 rounded-full bg-foreground align-middle",
            tone,
          )}
        />
      )}
      <span className="sr-only">{value ? "yes" : "no"}</span>
    </>
  );
}

type Column = {
  id: string;
  label: string;
  title?: string;
  numeric?: boolean;
  /** Boolean marks sit centered in their narrow column. */
  mark?: boolean;
  value: (row: SchemaRow) => string | number;
  render: (row: SchemaRow) => ReactNode;
  cellTitle?: (row: SchemaRow) => string | undefined;
};

type ColumnGroup = { label: string; columns: readonly Column[] };

const bool = (value: boolean) => (value ? 1 : 0);
const COLUMN_GROUPS: readonly ColumnGroup[] = [
  {
    label: "Identity",
    columns: [
      {
        id: "domain",
        label: "Domain",
        value: (row) => row.domain ?? "",
        render: (row) =>
          row.domain ? (
            <span className="text-foreground">
              {domainWayfinding(row.domain).label}
            </span>
          ) : (
            <span className="text-muted-foreground">Shared</span>
          ),
      },
      {
        id: "code",
        label: "Code",
        value: (row) => row.code ?? "",
        render: (row) => row.code ?? dash,
      },
      {
        id: "legacy",
        label: "Legacy",
        title: "Legacy QR prefix still resolved for printed labels",
        value: (row) => row.legacy ?? "",
        render: (row) => row.legacy ?? dash,
      },
      {
        id: "table",
        label: "Table",
        title: "Storage table",
        value: (row) => row.table ?? "",
        render: (row) => row.table ?? dash,
      },
      {
        id: "rows",
        label: "Rows",
        numeric: true,
        value: (row) => row.rows ?? -1,
        render: (row) => <Num value={row.rows} />,
      },
    ],
  },
  {
    label: "Kernel",
    columns: [
      ...CRUD_SLOTS.map((slot): Column => ({
        id: slot.key,
        label: slot.code,
        title: slot.key,
        mark: true,
        value: (row) => bool(row.crud[slot.key]),
        render: (row) => <Mark value={row.crud[slot.key]} />,
        cellTitle: (row) => `${slot.key}: ${row.crud[slot.key] ? "yes" : "no"}`,
      })),
      {
        id: "extras",
        label: "Extra",
        title: "Kernel actions beyond CRUD",
        value: (row) => row.extras.length,
        render: (row) =>
          row.extras.length > 0 ? (
            <span className="text-muted-foreground">
              {row.extras.join(" ")}
            </span>
          ) : (
            dash
          ),
      },
    ],
  },
  {
    label: "Relations",
    columns: [
      {
        id: "one",
        label: "1",
        title: "One-cardinality relations",
        numeric: true,
        value: (row) => row.one,
        render: (row) => <Num value={row.one} />,
      },
      {
        id: "many",
        label: "N",
        title: "Many-cardinality relations",
        numeric: true,
        value: (row) => row.many,
        render: (row) => <Num value={row.many} />,
      },
      {
        id: "declared",
        label: "Decl",
        title: "Hand-declared detail tables",
        numeric: true,
        value: (row) => row.tables.declared,
        render: (row) => <Num value={row.tables.declared} />,
      },
      {
        id: "derived",
        label: "Der",
        title: "Compiler-derived detail tables",
        numeric: true,
        value: (row) => row.tables.derived,
        render: (row) => <Num value={row.tables.derived} />,
      },
      {
        id: "omitted",
        label: "Omit",
        title: "Many relations without a detail table",
        numeric: true,
        value: (row) => row.tables.omitted,
        render: (row) => <Num value={row.tables.omitted} />,
      },
    ],
  },
  {
    label: "Surfaces",
    columns: [
      {
        id: "search",
        label: "Search",
        title:
          "semantic: lexical search plus an embedding; lexical: no embedding",
        value: (row) => row.search ?? "",
        render: (row) =>
          row.search === null ? (
            dash
          ) : (
            <span
              className={
                row.search === "lexical" ? "text-muted-foreground" : undefined
              }
            >
              {row.search}
            </span>
          ),
      },
      {
        id: "filters",
        label: "Filt",
        title: "Filters (ID filters in parentheses)",
        numeric: true,
        value: (row) => row.filters,
        render: (row) => (
          <>
            <Num value={row.filters} />
            {row.idFilters > 0 && (
              <span className="text-muted-foreground"> ({row.idFilters})</span>
            )}
          </>
        ),
      },
      {
        id: "sections",
        label: "Sect",
        title: "Detail page sections",
        numeric: true,
        value: (row) => row.sections,
        render: (row) => <Num value={row.sections} />,
      },
      {
        id: "deleteMode",
        label: "Delete",
        value: (row) => row.deleteMode ?? "",
        render: (row) => row.deleteMode ?? dash,
      },
      {
        id: "merge",
        label: "Mrg",
        title: "Merge",
        mark: true,
        value: (row) => bool(row.merge),
        render: (row) => <Mark value={row.merge} />,
        cellTitle: (row) => `merge: ${row.merge ? "yes" : "no"}`,
      },
      {
        id: "mcp",
        label: "MCP",
        title: "MCP owner and operation count",
        numeric: true,
        value: (row) => row.mcpOperations.length,
        render: (row) => (
          <>
            <span className="text-muted-foreground">
              {row.mcpOwner === "workflow" ? "wf " : ""}
            </span>
            <Num value={row.mcpOperations.length} />
          </>
        ),
        cellTitle: (row) =>
          `${row.mcpOwner ?? "none"}: ${row.mcpOperations.join(", ") || "—"}`,
      },
      {
        id: "overrides",
        label: "Ovr",
        title: "Declaration overrides",
        numeric: true,
        value: (row) => row.overrides,
        render: (row) => <Num value={row.overrides} />,
      },
      {
        id: "native",
        label: "Native calls",
        title:
          "HTTP actions and RPCs the native app calls — not whether it can browse the entity",
        value: (row) => row.native ?? "",
        render: (row) => (
          <span className="block max-w-[11rem] truncate text-muted-foreground">
            {row.native ?? "—"}
          </span>
        ),
        cellTitle: (row) => row.native ?? undefined,
      },
    ],
  },
];

const COLUMNS = COLUMN_GROUPS.flatMap((group) => group.columns);

const schemaHelper = createCubbyColumnHelper<SchemaRow>();
const schemaId = (row: SchemaRow) => row.entity;
const schemaSearch = {
  text: (row: SchemaRow) =>
    [
      row.entity,
      row.domain,
      ...COLUMNS.map((column) => column.cellTitle?.(row) ?? ""),
    ].join(" "),
  placeholder: "Search entities and declarations",
};
const schemaColumns = createCubbyColumnCollection<SchemaRow>((add) => {
  add(
    schemaHelper.accessor("entity", {
      header: "Entity",
      size: 200,
      meta: attachCubbyColumnMeta<SchemaRow>({
        entityColumnRole: "identity",
        mobile: { slot: "title", priority: 0 },
      }),
      cell: ({ row }) => (
        <span className="inline-flex items-center gap-1.5">
          <EntityIcon
            entity={row.original.entity}
            className="size-3.5 shrink-0"
          />
          {row.original.entity}
          {row.original.external ? (
            <span className="text-2xs text-muted-foreground">external</span>
          ) : null}
        </span>
      ),
    }),
  );
  COLUMN_GROUPS.forEach((group) =>
    group.columns.forEach((column) =>
      add(
        schemaHelper.accessor(column.value, {
          id: column.id,
          header: column.title ?? `${group.label} · ${column.label}`,
          size: column.numeric || column.mark ? 110 : 170,
          sortDescFirst: column.numeric ?? false,
          meta: attachCubbyColumnMeta<SchemaRow>({
            numeric: column.numeric,
            mobile: { slot: "meta", priority: 1 },
          }),
          cell: ({ row }) => (
            <span title={column.cellTitle?.(row.original)}>
              {column.render(row.original)}
            </span>
          ),
        }),
      ),
    ),
  );
});

function SchemaTable({
  rows,
  selected,
  onSelect,
}: {
  rows: readonly SchemaRow[];
  selected: Entity | null;
  onSelect: (entity: Entity | null) => void;
}) {
  const table = useLocalTable({
    rows,
    columns: schemaColumns,
    getRowId: schemaId,
    search: schemaSearch,
  });
  const close = () => onSelect(null);
  return (
    <RTable
      table={table}
      embedded
      showColumnMenu
      ariaLabel="Entity schema"
      withoutImages="Schema declarations describe entity types, not household records."
      currentRowId={selected ?? undefined}
      onRowClick={(row) => onSelect(row.original.entity)}
      disableMobileDetailsHref
      inspector={{
        content: selected ? (
          <EntitySchemaPanel
            entity={selected}
            onSelect={onSelect}
            onClose={close}
          />
        ) : null,
        title: "Entity schema",
        onClose: close,
      }}
    />
  );
}

/** Entity × entity relation coverage. Rows are the relation's source, columns
 * its target; each dot is one declared relationship, colored by whether its
 * detail table is declared, derived, or missing — the place coverage gaps
 * stay visible at a glance instead of hiding in 27 separate panels. */
function RelationsMatrix({
  onSelect,
  graph,
}: {
  onSelect: (entity: Entity) => void;
  graph: SchemaOverview["graph"];
}) {
  return (
    <div className="space-y-2">
      <Table
        containerClassName="max-h-[calc(100dvh-12rem)] overflow-auto border-t border-l border-border"
        className="table-auto border-separate border-spacing-0 font-mono text-2xs"
      >
        <TableHeader className="sticky top-0 z-20">
          <TableRow>
            <TableHead className={cn(gridHead, "sticky left-0 z-10 h-6")}>
              from \ to
            </TableHead>
            {graph.map(({ entity: target, abbreviation }) => (
              <TableHead
                key={target}
                title={target}
                className={cn(gridHead, "h-6 text-center")}
              >
                {abbreviation}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {graph.map(({ entity: source, abbreviation, relationships }) => (
            <TableRow key={source} className="group/row">
              <TableHead
                scope="row"
                className={cn(
                  gridCell,
                  "sticky left-0 z-10 h-6 bg-card p-0 text-left font-normal group-hover/row:bg-muted",
                )}
              >
                <button
                  type="button"
                  title={`Open ${source} in the entities sheet`}
                  onClick={() => onSelect(source)}
                  className="size-full px-2 text-left hover:underline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
                >
                  {abbreviation}
                </button>
              </TableHead>
              {allEntities.map((target) => {
                const details = relationships.filter(
                  (relation) => relation.target === target,
                );
                return (
                  <TableCell
                    key={target}
                    title={
                      details
                        .map(
                          ({ key, detail }) =>
                            `${key}: ${detail.status}${detail.reason ? ` — ${detail.reason}` : ""}`,
                        )
                        .join("\n") || undefined
                    }
                    className={cn(
                      gridCell,
                      "h-6 bg-card px-1 text-center group-hover/row:bg-muted",
                    )}
                  >
                    {details.map(({ key, cardinality, detail }) => (
                      <span
                        key={key}
                        className={cn(
                          "mx-px",
                          relationStatusClass(detail.status),
                        )}
                      >
                        {cardinality === "many" ? "●" : "○"}
                      </span>
                    ))}
                  </TableCell>
                );
              })}
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <div className="flex flex-wrap gap-3 text-2xs text-muted-foreground">
        {RELATION_STATUS_LEGEND.map(([status, label]) => (
          <span key={status} className="inline-flex items-center gap-1">
            <span className={relationStatusClass(status)}>●</span> {label}
          </span>
        ))}
        <span>○ one-cardinality</span>
      </div>
    </div>
  );
}

function PhotoCategoriesTable({
  photos,
}: {
  photos: SchemaOverview["photos"];
}) {
  return (
    <StaticTable
      containerClassName="overflow-auto border-t border-l border-border"
      className="w-full table-auto border-separate border-spacing-0 text-xs"
      rows={photos}
      rowKey={(category) => category.key}
      columns={[
        {
          id: "column-0",
          header: "Category",
          headClassName: cn(gridHead, "h-7 text-left"),
          cellClassName: cn(gridCell, "bg-card"),
          cell: (category) => (
            <>
              <span aria-hidden className="mr-1">
                {category.emoji}
              </span>
              {category.label}
            </>
          ),
        },
        {
          id: "column-1",
          header: "Entities",
          headClassName: cn(gridHead, "h-7 text-left"),
          cellClassName: cn(gridCell, "bg-card font-mono"),
          cell: (category) => category.entities.join(" · "),
        },
        {
          id: "column-2",
          header: "Classifier labels (effective)",
          headClassName: cn(gridHead, "h-7 text-left"),
          cellClassName: cn(gridCell, "bg-card py-1 whitespace-normal"),
          cell: (category) => (
            <div className="flex flex-wrap gap-1">
              {category.classifierLabels.map((label) => (
                <Badge
                  key={label}
                  variant="outline"
                  className="font-mono text-2xs"
                >
                  {label}
                </Badge>
              ))}
            </div>
          ),
        },
      ]}
    />
  );
}

function SummaryBar({ totals }: { totals: SchemaOverview["totals"] }) {
  const stats: readonly [string, ReactNode][] = [
    ["declared", totals.declared],
    ["generic CRUD", totals.crud],
    ["search + embed", totals.search],
    ["MCP exposed", totals.mcp],
    ["explicit ports", totals.ports],
    ["overrides", totals.overrides],
    ["QR compat", "P- · L-"],
  ];
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 border-y border-border bg-muted/40 px-2 py-1.5 text-2xs">
      <p className="flex flex-wrap gap-x-4 gap-y-1">
        {stats.map(([label, value]) => (
          <span key={label} className="flex items-baseline gap-1">
            <span className="font-mono text-xs font-medium tabular-nums">
              {value}
            </span>
            <span className="text-muted-foreground">{label}</span>
          </span>
        ))}
      </p>
      <p className="font-mono text-muted-foreground">
        entity spec → contracts + bindings →{" "}
        <span className="text-foreground">executeEntity</span> → Start /
        workflow / MCP → routes, pages, search, lifecycle
      </p>
    </div>
  );
}

function ManifestGrid({
  selected,
  onSelect,
  sheet = "entities",
  onSheetChange,
  active = true,
}: {
  selected: Entity | null;
  onSelect: (entity: Entity | null) => void;
  sheet?: SchemaSheet;
  onSheetChange: (sheet: SchemaSheet) => void;
  active?: boolean;
}) {
  const { data: overview } = useSuspenseQuery(schemaOverviewQueryOptions());
  const session = authClient.useSession();
  const { data: health } = useQuery({
    ...entityInspectorHealth.inspectorHealth.queryOptions(null),
    enabled: active && !!session.data?.user,
  });
  const counts: EntityInspectorHealth["counts"] | undefined = health?.counts;
  const rows = useMemo(
    () =>
      overview.rows.map((row) => ({
        ...row,
        rows: row.countable ? counts?.[row.entity] : undefined,
      })),
    [overview, counts],
  );
  const totals = overview.totals;
  const openEntity = (entity: Entity) => {
    onSheetChange("entities");
    onSelect(entity);
  };

  return (
    <div className="space-y-2">
      <SummaryBar totals={totals} />
      <Tabs
        value={sheet}
        onValueChange={(value) => onSheetChange(schemaSheetSchema.parse(value))}
      >
        <TabsList className="h-auto max-w-full flex-wrap justify-start gap-0.5 p-0.5 [&>[data-slot=tabs-trigger]]:flex-none">
          <TabsTrigger value="entities" className="text-xs">
            Entities{" "}
            <span className="font-mono text-muted-foreground">
              {totals.declared}
            </span>
          </TabsTrigger>
          <TabsTrigger value="overrides" className="text-xs">
            Overrides{" "}
            <span className="font-mono text-muted-foreground">
              {totals.overrides}
            </span>
          </TabsTrigger>
          <TabsTrigger value="relations" className="text-xs">
            Relations matrix
          </TabsTrigger>
          <TabsTrigger value="photos" className="text-xs">
            Photo categories
          </TabsTrigger>
          <TabsTrigger value="graph" className="text-xs">
            Reference graph
          </TabsTrigger>
        </TabsList>
        <TabsContent value="entities">
          <SchemaTable rows={rows} selected={selected} onSelect={onSelect} />
        </TabsContent>
        <TabsContent value="overrides">
          <EntityOverrideTable onSelectEntity={openEntity} />
        </TabsContent>
        <TabsContent value="relations">
          <RelationsMatrix onSelect={openEntity} graph={overview.graph} />
        </TabsContent>
        <TabsContent value="photos">
          <PhotoCategoriesTable photos={overview.photos} />
        </TabsContent>
        <TabsContent value="graph">
          {sheet === "graph" && <EntityReferenceGraph />}
        </TabsContent>
      </Tabs>
    </div>
  );
}

export function EntityManifestGrid(props: Parameters<typeof ManifestGrid>[0]) {
  if (props.active === false) return null;
  return (
    <QuerySection title="Entity schema" fallback={null}>
      <ManifestGrid {...props} />
    </QuerySection>
  );
}
