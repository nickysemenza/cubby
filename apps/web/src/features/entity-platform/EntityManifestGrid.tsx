import type { Entity } from "@cubby/schemas/entity";
import { allEntities, photoCategories } from "@cubby/schemas/entity-manifest";
import { CaretDownIcon } from "@phosphor-icons/react/dist/csr/CaretDown";
import { CaretUpIcon } from "@phosphor-icons/react/dist/csr/CaretUp";
import { useQuery } from "@tanstack/react-query";
import {
  type KeyboardEvent,
  type RefObject,
  useEffect,
  useEffectEvent,
  type ReactNode,
  useMemo,
  useRef,
  useState,
} from "react";

import { EntityIcon } from "~/entity/entities";
import type { EntityInspectorHealth } from "~/entity/entity-inspector-health";
import { entityInspectorHealth } from "~/integrations/tanstack-query/generated/catalog.gen";
import { authClient } from "~/lib/auth-client";
import { cn } from "~/lib/utils";
import { domainWayfinding } from "~/ui/navigation/domain-wayfinding";
import { Badge } from "~/ui/primitives/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/ui/primitives/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/ui/primitives/tabs";

import {
  CRUD_SLOTS,
  RELATION_STATUS_LEGEND,
  type SchemaRow,
  abbrev,
  extendedManifest,
  relationDetailStatus,
  relationStatusClass,
  schemaRow,
  schemaTotals,
} from "./entity-schema-model";
import { EntityOverrideTable } from "./EntityOverrideTable";
import { EntityReferenceGraph } from "./EntityReferenceGraph";
import { EntitySchemaPanel } from "./EntitySchemaInspector";
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
  compare: (left: SchemaRow, right: SchemaRow) => number;
  render: (row: SchemaRow) => ReactNode;
  cellTitle?: (row: SchemaRow) => string | undefined;
};

type ColumnGroup = { label: string; columns: readonly Column[] };

const bool = (value: boolean) => (value ? 1 : 0);
const byNumber =
  (value: (row: SchemaRow) => number) => (left: SchemaRow, right: SchemaRow) =>
    value(left) - value(right);
const byText =
  (value: (row: SchemaRow) => string) => (left: SchemaRow, right: SchemaRow) =>
    value(left).localeCompare(value(right));

const COLUMN_GROUPS: readonly ColumnGroup[] = [
  {
    label: "Identity",
    columns: [
      {
        id: "domain",
        label: "Domain",
        compare: byText((row) => row.domain ?? ""),
        render: (row) =>
          row.domain ? (
            <span
              style={{
                color: `var(${domainWayfinding(row.domain).accentToken})`,
              }}
            >
              {domainWayfinding(row.domain).label}
            </span>
          ) : (
            dash
          ),
      },
      {
        id: "code",
        label: "Code",
        compare: byText((row) => row.code ?? ""),
        render: (row) => row.code ?? dash,
      },
      {
        id: "legacy",
        label: "Legacy",
        title: "Legacy QR prefix still resolved for printed labels",
        compare: byText((row) => row.legacy ?? ""),
        render: (row) => row.legacy ?? dash,
      },
      {
        id: "table",
        label: "Table",
        title: "Storage table",
        compare: byText((row) => row.table ?? ""),
        render: (row) => row.table ?? dash,
      },
      {
        id: "rows",
        label: "Rows",
        numeric: true,
        compare: byNumber((row) => row.rows ?? -1),
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
        compare: byNumber((row) => bool(row.crud[slot.key])),
        render: (row) => <Mark value={row.crud[slot.key]} />,
        cellTitle: (row) => `${slot.key}: ${row.crud[slot.key] ? "yes" : "no"}`,
      })),
      {
        id: "extras",
        label: "Extra",
        title: "Kernel actions beyond CRUD",
        compare: byNumber((row) => row.extras.length),
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
        compare: byNumber((row) => row.one),
        render: (row) => <Num value={row.one} />,
      },
      {
        id: "many",
        label: "N",
        title: "Many-cardinality relations",
        numeric: true,
        compare: byNumber((row) => row.many),
        render: (row) => <Num value={row.many} />,
      },
      {
        id: "declared",
        label: "Decl",
        title: "Hand-declared detail tables",
        numeric: true,
        compare: byNumber((row) => row.tables.declared),
        render: (row) => <Num value={row.tables.declared} />,
      },
      {
        id: "derived",
        label: "Der",
        title: "Compiler-derived detail tables",
        numeric: true,
        compare: byNumber((row) => row.tables.derived),
        render: (row) => <Num value={row.tables.derived} />,
      },
      {
        id: "omitted",
        label: "Omit",
        title: "Many relations without a detail table",
        numeric: true,
        compare: byNumber((row) => row.tables.omitted),
        render: (row) => <Num value={row.tables.omitted} />,
      },
    ],
  },
  {
    label: "Surfaces",
    columns: [
      {
        id: "search",
        label: "Srch",
        title: "Lexical + semantic search",
        mark: true,
        compare: byNumber((row) => bool(row.searchable)),
        render: (row) => <Mark value={row.searchable} />,
        cellTitle: (row) => `search: ${row.searchable ? "yes" : "no"}`,
      },
      {
        id: "filters",
        label: "Filt",
        title: "Filters (ID filters in parentheses)",
        numeric: true,
        compare: byNumber((row) => row.filters),
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
        compare: byNumber((row) => row.sections),
        render: (row) => <Num value={row.sections} />,
      },
      {
        id: "deleteMode",
        label: "Delete",
        compare: byText((row) => row.deleteMode ?? ""),
        render: (row) => row.deleteMode ?? dash,
      },
      {
        id: "merge",
        label: "Mrg",
        title: "Merge",
        mark: true,
        compare: byNumber((row) => bool(row.merge)),
        render: (row) => <Mark value={row.merge} />,
        cellTitle: (row) => `merge: ${row.merge ? "yes" : "no"}`,
      },
      {
        id: "mcp",
        label: "MCP",
        title: "MCP owner and operation count",
        numeric: true,
        compare: byNumber((row) => row.mcpOperations.length),
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
        compare: byNumber((row) => row.overrides),
        render: (row) => <Num value={row.overrides} />,
      },
      {
        id: "native",
        label: "Native app",
        compare: byText((row) => row.native ?? ""),
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

type Sort = { id: string; desc: boolean } | null;

/** Numbers sort largest first, text A→Z; a third click restores declaration order. */
function nextSort(sort: Sort, column: Column): Sort {
  const firstDesc = column.numeric ?? false;
  if (sort?.id !== column.id) return { id: column.id, desc: firstDesc };
  if (sort.desc === firstDesc) return { id: column.id, desc: !firstDesc };
  return null;
}

function SchemaTable({
  rows,
  selected,
  onSelect,
  buttons,
}: {
  rows: readonly SchemaRow[];
  selected: Entity | null;
  onSelect: (entity: Entity | null) => void;
  buttons: RefObject<Map<Entity, HTMLButtonElement>>;
}) {
  const [sort, setSort] = useState<Sort>(null);
  const sorted = useMemo(() => {
    const column =
      sort && COLUMNS.find((candidate) => candidate.id === sort.id);
    if (!column) return rows;
    return [...rows].sort((left, right) =>
      sort.desc ? column.compare(right, left) : column.compare(left, right),
    );
  }, [rows, sort]);

  const onKeyDown = (event: KeyboardEvent<HTMLTableSectionElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const focused = sorted.findIndex(
      (row) => buttons.current.get(row.entity) === document.activeElement,
    );
    if (focused === -1) return;
    event.preventDefault();
    const next = sorted[focused + (event.key === "ArrowDown" ? 1 : -1)]?.entity;
    if (!next) return;
    buttons.current.get(next)?.focus();
    // Moving through rows only follows with the panel once one is open,
    // so arrowing through the sheet never pops a panel uninvited.
    if (selected) onSelect(next);
  };

  return (
    <Table
      containerClassName="max-h-[calc(100dvh-12rem)] overflow-auto border-t border-l border-border"
      aria-label="Entity schema"
      className="w-full table-auto border-separate border-spacing-0 font-mono text-xs tabular-nums"
    >
      <TableHeader className="sticky top-0 z-20">
        <TableRow>
          <TableHead
            rowSpan={2}
            className={cn(
              gridHead,
              "sticky left-0 z-10 h-12 min-w-[11rem] text-left align-bottom",
            )}
          >
            Entity
          </TableHead>
          {COLUMN_GROUPS.map((group) => (
            <TableHead
              key={group.label}
              colSpan={group.columns.length}
              className={cn(gridHead, "h-5 text-left font-sans")}
            >
              {group.label}
            </TableHead>
          ))}
        </TableRow>
        <TableRow>
          {COLUMNS.map((column) => {
            const active = sort?.id === column.id;
            return (
              <TableHead
                key={column.id}
                aria-sort={
                  active ? (sort.desc ? "descending" : "ascending") : undefined
                }
                className={cn(gridHead, "h-7 p-0")}
              >
                <button
                  type="button"
                  title={column.title ?? column.label}
                  onClick={() => setSort(nextSort(sort, column))}
                  className={cn(
                    "inline-flex size-full items-center gap-0.5 px-2 hover:bg-[var(--brand-hairline)] hover:text-foreground focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
                    column.numeric && "justify-end",
                    column.mark && "justify-center",
                    active && "text-foreground",
                  )}
                >
                  {column.label}
                  {active &&
                    (sort.desc ? (
                      <CaretDownIcon aria-hidden className="size-2.5" />
                    ) : (
                      <CaretUpIcon aria-hidden className="size-2.5" />
                    ))}
                </button>
              </TableHead>
            );
          })}
        </TableRow>
      </TableHeader>
      <TableBody onKeyDown={onKeyDown}>
        {sorted.map((row) => {
          const isSelected = selected === row.entity;
          return (
            <TableRow
              key={row.entity}
              data-state={isSelected ? "selected" : undefined}
              aria-current={isSelected ? "true" : undefined}
              className="group/row cursor-default"
              onClick={() => onSelect(isSelected ? null : row.entity)}
            >
              <TableCell
                className={cn(
                  gridCell,
                  "sticky left-0 z-10 bg-card p-0 group-hover/row:bg-muted group-data-[state=selected]/row:bg-[var(--row-selected)] group-data-[state=selected]/row:shadow-[inset_2px_0_0_var(--foreground)]",
                )}
              >
                <button
                  ref={(node) => {
                    if (node) buttons.current.set(row.entity, node);
                    else buttons.current.delete(row.entity);
                  }}
                  type="button"
                  aria-pressed={isSelected}
                  className="flex size-full items-center gap-1.5 px-2 text-left font-mono focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
                >
                  <EntityIcon
                    entity={row.entity}
                    colored
                    className="size-3.5 shrink-0"
                  />
                  {row.entity}
                </button>
              </TableCell>
              {COLUMNS.map((column) => (
                <TableCell
                  key={column.id}
                  title={column.cellTitle?.(row)}
                  className={cn(
                    gridCell,
                    "bg-card group-hover/row:bg-muted group-data-[state=selected]/row:bg-[var(--row-selected)]",
                    column.numeric
                      ? "text-right"
                      : column.mark
                        ? "text-center"
                        : "text-left",
                  )}
                >
                  {column.render(row)}
                </TableCell>
              ))}
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

/** Entity × entity relation coverage. Rows are the relation's source, columns
 * its target; each dot is one declared relationship, colored by whether its
 * detail table is declared, derived, or missing — the place coverage gaps
 * stay visible at a glance instead of hiding in 27 separate panels. */
function RelationsMatrix({ onSelect }: { onSelect: (entity: Entity) => void }) {
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
            {allEntities.map((target) => (
              <TableHead
                key={target}
                title={target}
                className={cn(gridHead, "h-6 text-center")}
              >
                {abbrev(target)}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {allEntities.map((source) => (
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
                  {abbrev(source)}
                </button>
              </TableHead>
              {allEntities.map((target) => {
                const relations = extendedManifest(source).relationships.filter(
                  (relation) => relation.target === target,
                );
                const details = relations.map((relation) => ({
                  relation,
                  detail: relationDetailStatus(source, relation),
                }));
                return (
                  <TableCell
                    key={target}
                    title={
                      details
                        .map(
                          ({ relation, detail }) =>
                            `${relation.key}: ${detail.status}${detail.reason ? ` — ${detail.reason}` : ""}`,
                        )
                        .join("\n") || undefined
                    }
                    className={cn(
                      gridCell,
                      "h-6 bg-card px-1 text-center group-hover/row:bg-muted",
                    )}
                  >
                    {details.map(({ relation, detail }) => (
                      <span
                        key={relation.key}
                        className={cn(
                          "mx-px",
                          relationStatusClass(detail.status),
                        )}
                      >
                        {relation.cardinality === "many" ? "●" : "○"}
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

function PhotoCategoriesTable() {
  return (
    <Table
      containerClassName="overflow-auto border-t border-l border-border"
      className="w-full table-auto border-separate border-spacing-0 text-xs"
    >
      <TableHeader>
        <TableRow>
          <TableHead className={cn(gridHead, "h-7 text-left")}>
            Category
          </TableHead>
          <TableHead className={cn(gridHead, "h-7 text-left")}>
            Entities
          </TableHead>
          <TableHead className={cn(gridHead, "h-7 text-left")}>
            Classifier labels (effective)
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {Object.values(photoCategories).map((category) => (
          <TableRow key={category.key}>
            <TableCell className={cn(gridCell, "bg-card")}>
              <span aria-hidden className="mr-1">
                {category.emoji}
              </span>
              {category.label}
            </TableCell>
            <TableCell className={cn(gridCell, "bg-card font-mono")}>
              {category.entities.join(" · ")}
            </TableCell>
            <TableCell
              className={cn(gridCell, "bg-card py-1 whitespace-normal")}
            >
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
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function SummaryBar({ totals }: { totals: ReturnType<typeof schemaTotals> }) {
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

export function EntityManifestGrid({
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
  const session = authClient.useSession();
  const { data: health } = useQuery({
    ...entityInspectorHealth.inspectorHealth.queryOptions(null),
    enabled: active && !!session.data?.user,
  });
  const counts: EntityInspectorHealth["counts"] | undefined = health?.counts;
  const rows = useMemo(
    () => allEntities.map((entity) => schemaRow(entity, counts)),
    [counts],
  );
  const totals = useMemo(schemaTotals, []);
  // Row buttons live here so closing the panel can hand focus back to the
  // row it described instead of dropping it with the unmounted panel.
  const buttons = useRef(new Map<Entity, HTMLButtonElement>());
  const closePanel = () => {
    if (!selected) return;
    buttons.current.get(selected)?.focus();
    onSelect(null);
  };
  const onEscape = useEffectEvent(closePanel);
  useEffect(() => {
    if (!selected) return;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) onEscape();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [selected]);
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
          <div
            className={cn(
              "min-w-0",
              selected && "xl:grid xl:grid-cols-[minmax(0,1fr)_24rem]",
            )}
          >
            <SchemaTable
              rows={rows}
              selected={selected}
              onSelect={onSelect}
              buttons={buttons}
            />
            {selected && (
              // Docked beside the sheet at 1280px+, a right-edge drawer below.
              <aside className="z-40 overflow-y-auto border-border bg-card max-xl:fixed max-xl:inset-y-0 max-xl:right-0 max-xl:w-[min(24rem,100vw)] max-xl:border-l max-xl:shadow-xl xl:sticky xl:top-0 xl:max-h-[calc(100dvh-12rem)] xl:border-y xl:border-r">
                <EntitySchemaPanel
                  entity={selected}
                  onSelect={onSelect}
                  onClose={closePanel}
                />
              </aside>
            )}
          </div>
        </TabsContent>
        <TabsContent value="overrides">
          <EntityOverrideTable onSelectEntity={openEntity} />
        </TabsContent>
        <TabsContent value="relations">
          <RelationsMatrix onSelect={openEntity} />
        </TabsContent>
        <TabsContent value="photos">
          <PhotoCategoriesTable />
        </TabsContent>
        <TabsContent value="graph">
          {sheet === "graph" && <EntityReferenceGraph />}
        </TabsContent>
      </Tabs>
    </div>
  );
}
