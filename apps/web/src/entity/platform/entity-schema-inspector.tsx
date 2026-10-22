import type { Entity } from "@cubby/schemas/entity";
import { ArrowSquareOutIcon } from "@phosphor-icons/react/dist/csr/ArrowSquareOut";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

import {
  EntityIcon,
  browserEntityDefinition,
  isBrowserRoutedEntity,
} from "~/entity/entities";
import { viewsForEntity } from "~/entity/model/view-manifest";
import { cn } from "~/lib/utils";
import { Facts as SharedFacts } from "~/ui/common/facts";
import { domainWayfinding } from "~/ui/navigation/domain-wayfinding";
import { SidePanel, useTableRowStep } from "~/ui/overlays/side-panel";
import { Badge } from "~/ui/primitives/badge";
import { buttonVariants } from "~/ui/primitives/button";
import { StaticTable } from "~/ui/primitives/static-table";

import {
  DETAIL_STATUS_LABEL,
  type OverrideComparison,
  extendedManifest,
  metadataFor,
  overridesFor,
  relationDetailStatus,
  relationStatusClass,
  schemaRow,
} from "./entity-schema-model";

const dash = <span className="text-muted-foreground/40">—</span>;
const cell = "border-b border-border/60 px-2 py-1 align-top";
const head =
  "h-7 border-b border-border bg-muted px-2 text-left text-sm font-medium text-muted-foreground";

/** Selecting another entity inside the panel keeps the user in the sheet;
 * the full page navigates between schema pages instead. */
type EntityTarget = (entity: Entity) => ReactNode;

const panelTarget =
  (onSelect: (entity: Entity) => void): EntityTarget =>
  (entity) => (
    <button
      type="button"
      className="font-mono hover:underline focus-visible:outline-2 focus-visible:outline-ring"
      onClick={() => onSelect(entity)}
    >
      {entity}
    </button>
  );

const pageTarget: EntityTarget = (entity) => (
  <Link
    to="/entities/schema/$entity"
    params={{ entity }}
    className="font-mono hover:underline"
  >
    {entity}
  </Link>
);

function Heading({ title, count }: { title: string; count?: number }) {
  return (
    <h3 className="flex items-baseline gap-2 text-sm font-semibold">
      {title}
      {count !== undefined && (
        <span className="font-mono font-normal text-muted-foreground tabular-nums">
          {count}
        </span>
      )}
    </h3>
  );
}

export function SavedViewChips({ entity }: { entity: Entity }) {
  const views = viewsForEntity(entity);
  if (views.length === 0) return dash;
  return (
    <div className="flex flex-wrap gap-1">
      {views.map((view) => (
        <Badge key={view.label} variant="outline" className="text-2xs">
          {view.label}
        </Badge>
      ))}
    </div>
  );
}

/** A two-column property sheet: label column, value column, hairline rows. */
function SchemaFacts({ entity, wide }: { entity: Entity; wide?: boolean }) {
  const row = schemaRow(entity, undefined);
  const metadata = metadataFor(entity);
  const route = isBrowserRoutedEntity(entity)
    ? browserEntityDefinition(entity).routes
    : null;
  const repository = metadata.ports.repository;
  const facts: readonly [string, ReactNode][] = [
    ["Code", row.code ?? dash],
    ["Legacy code", row.legacy ?? dash],
    ["Storage table", row.table ?? dash],
    ["Domain", row.domain ? domainWayfinding(row.domain).label : "Shared"],
    ["Routes", route ? `${route.list} · ${route.detail}` : "workflow owned"],
    [
      "Detail",
      `${metadata.detail.variant} · ${metadata.detail.sections.length} sections`,
    ],
    [
      "Relation tables",
      `${row.tables.declared} declared · ${row.tables.derived} derived · ${row.tables.omitted} omitted`,
    ],
    ["Filters", `${row.filters} total · ${row.idFilters} ID`],
    [
      "Search",
      row.search === "semantic"
        ? "lexical + semantic"
        : row.search === "lexical"
          ? "lexical only"
          : "not searchable",
    ],
    [
      "Delete / merge",
      `${row.deleteMode ?? "none"} · ${row.merge ? "merge" : "no merge"}`,
    ],
    [
      "MCP",
      `${row.mcpOwner ?? "none"} · ${row.mcpOperations.join(", ") || "no operations"}`,
    ],
    ["Native calls", row.native ?? dash],
    [
      "Repository port",
      repository
        ? `${repository.module}#${repository.export}`
        : "none (external workflow)",
    ],
    [
      "Printed labels",
      entity === "product" || entity === "location" ? "yes" : "no",
    ],
  ];
  return (
    <SharedFacts
      layout="inline"
      facts={facts.map(([label, value]) => ({
        label,
        value,
        className: "min-w-0 break-words font-mono text-sm",
      }))}
      className={cn(
        "grid grid-cols-1 gap-x-6 border-y border-border/60 py-1",
        wide && "lg:grid-cols-2",
      )}
    />
  );
}

/** `invalid`: the manifest does not compile without this input. */
function OutcomeBadge({ status }: { status: OverrideComparison["status"] }) {
  return status === "invalid" ? (
    <Badge variant="secondary" className="text-2xs" title={REQUIRED_TITLE}>
      required
    </Badge>
  ) : (
    <Badge variant="outline" className="text-2xs">
      changes default
    </Badge>
  );
}

const REQUIRED_TITLE =
  "Removing this input fails compilation; the compiler has no valid default.";

function Overrides({ entity, full }: { entity: Entity; full?: boolean }) {
  const overrides = overridesFor(entity);
  if (overrides.length === 0)
    return (
      <p className="text-xs text-muted-foreground">No overrides declared.</p>
    );
  if (!full)
    return (
      <ul className="border-t border-border/60 text-sm">
        {overrides.map((override) => (
          <li
            key={override.path}
            className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-2 border-b border-border/60 py-1"
          >
            <div className="min-w-0">
              <div className="font-mono text-2xs break-all">
                {override.path}
              </div>
              <code
                className="block truncate font-mono text-2xs text-muted-foreground"
                title={override.declared}
              >
                {override.declared}
              </code>
            </div>
            <OutcomeBadge status={override.status} />
          </li>
        ))}
      </ul>
    );
  return (
    <StaticTable
      className="w-full table-fixed border-collapse text-sm"
      rows={overrides}
      rowKey={(override) => override.path}
      columns={[
        {
          id: "column-0",
          header: "Override path",
          headClassName: cn(head, "w-[26%]"),
          cellClassName: cn(cell, "font-mono text-2xs break-all"),
          cell: (override) => override.path,
        },
        {
          id: "column-1",
          header: "Declared",
          headClassName: cn(head, "w-[30%]"),
          cellClassName: cell,
          cell: (override) => (
            <pre className="max-h-48 overflow-auto font-mono text-2xs break-all whitespace-pre-wrap">
              {override.declared}
            </pre>
          ),
        },
        {
          id: "column-2",
          header: "Without override",
          headClassName: cn(head, "w-[30%]"),
          cellClassName: cell,
          cell: (override) =>
            override.without === null ? (
              <span className="text-2xs text-muted-foreground">
                No valid value
                {override.reason && (
                  <span className="mt-0.5 block text-destructive">
                    {override.reason}
                  </span>
                )}
              </span>
            ) : (
              <pre className="max-h-48 overflow-auto font-mono text-2xs break-all whitespace-pre-wrap">
                {override.without}
              </pre>
            ),
        },
        {
          id: "column-3",
          header: "Outcome",
          headClassName: cn(head, "w-[14%]"),
          cellClassName: cell,
          cell: (override) => <OutcomeBadge status={override.status} />,
        },
      ]}
    />
  );
}

function Relations({
  entity,
  target,
  full,
}: {
  entity: Entity;
  target: EntityTarget;
  full?: boolean;
}) {
  const relationships = extendedManifest(entity).relationships;
  if (relationships.length === 0)
    return (
      <p className="text-xs text-muted-foreground">
        {entity} declares no relations.
      </p>
    );
  return (
    <StaticTable
      className="w-full table-auto border-collapse text-sm"
      rows={relationships}
      rowKey={(relation) => relation.key}
      columns={[
        {
          id: "column-0",
          header: "Key",
          headClassName: head,
          cellClassName: cn(cell, "font-mono"),
          cell: (relation) => relation.key,
        },
        {
          id: "column-1",
          header: "Target",
          headClassName: head,
          cellClassName: cell,
          cell: (relation) => target(relation.target),
        },
        {
          id: "column-2",
          header: "Card.",
          headProps: { className: head, title: "Cardinality" },
          cellClassName: cell,
          cell: (relation) => relation.cardinality,
        },
        {
          id: "column-3",
          header: "Origin",
          hidden: !full,
          headClassName: head,
          cellClassName: cell,
          cell: (relation) => (relation.derived ? "derived" : "declared"),
        },
        {
          id: "column-4",
          header: "Detail table",
          headClassName: head,
          cellProps: (relation) => {
            const detail = relationDetailStatus(entity, relation);
            return {
              title: detail.reason,
              className: cn(cell, relationStatusClass(detail.status)),
            };
          },
          cell: (relation) => {
            const detail = relationDetailStatus(entity, relation);
            return DETAIL_STATUS_LABEL[detail.status];
          },
        },
        {
          id: "column-5",
          header: "Filter",
          hidden: !full,
          headClassName: head,
          cellClassName: cn(cell, "font-mono"),
          cell: (relation) => {
            const detail = relationDetailStatus(entity, relation);
            return detail.descriptor ?? dash;
          },
        },
        {
          id: "column-6",
          header: "Notes",
          hidden: !full,
          headClassName: head,
          cellClassName: cn(cell, "text-muted-foreground"),
          cell: (relation) => {
            const detail = relationDetailStatus(entity, relation);
            return detail.reason ?? relation.label;
          },
        },
      ]}
    />
  );
}

function Filters({ entity }: { entity: Entity }) {
  const filters = metadataFor(entity).filterDescriptors;
  if (filters.length === 0)
    return <p className="text-xs text-muted-foreground">No filters.</p>;
  return (
    <StaticTable
      className="w-full table-auto border-collapse text-sm"
      rows={filters}
      rowKey={(filter) => filter.urlKey}
      columns={[
        {
          id: "column-0",
          header: "URL key",
          headClassName: head,
          cellClassName: cn(cell, "font-mono"),
          cell: (filter) => filter.urlKey,
        },
        {
          id: "column-1",
          header: "Kind",
          headClassName: head,
          cellClassName: cn(cell, "font-mono"),
          cell: (filter) => filter.kind,
        },
        {
          id: "column-2",
          header: "Field",
          headClassName: head,
          cellClassName: cn(cell, "font-mono"),
          cell: (filter) => filter.field ?? dash,
        },
        {
          id: "column-3",
          header: "Label",
          headClassName: head,
          cellClassName: cell,
          cell: (filter) => filter.label ?? dash,
        },
      ]}
    />
  );
}

function DetailSectionsTable({ entity }: { entity: Entity }) {
  const sections = metadataFor(entity).detail.sections;
  return (
    <StaticTable
      className="w-full table-auto border-collapse text-sm"
      rows={sections}
      rowKey={(section) => section.id}
      columns={[
        {
          id: "column-0",
          header: "Section",
          headClassName: head,
          cellClassName: cn(cell, "font-mono"),
          cell: (section) => section.id,
        },
        {
          id: "column-1",
          header: "Kind",
          headClassName: head,
          cellClassName: cn(cell, "font-mono"),
          cell: (section) => section.kind,
        },
        {
          id: "column-2",
          header: "Title",
          headClassName: head,
          cellClassName: cell,
          cell: (section) => section.title ?? dash,
        },
        {
          id: "column-3",
          header: "Placement",
          headClassName: head,
          cellClassName: cell,
          cell: (section) => section.placement,
        },
      ]}
    />
  );
}

function Identity({ entity }: { entity: Entity }) {
  const metadata = metadataFor(entity);
  return (
    <div className="flex min-w-0 items-start gap-2">
      <EntityIcon entity={entity} className="mt-1 size-5 shrink-0" />
      <div className="min-w-0">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className="font-serif text-lg leading-tight">{entity}</span>
          <span className="font-mono text-2xs text-muted-foreground">
            {schemaRow(entity, undefined).code}
          </span>
        </div>
        {metadata.description && (
          <p className="text-xs text-muted-foreground">
            {metadata.description}
          </p>
        )}
      </div>
    </div>
  );
}

/** The docked side panel: a bounded preview of one entity's effective
 * schema, with the full page one click away. */
export function EntitySchemaPanel({
  entity,
  onSelect,
  onClose,
}: {
  entity: Entity;
  onSelect: (entity: Entity) => void;
  onClose: () => void;
}) {
  const overrides = overridesFor(entity).length;
  const relations = extendedManifest(entity).relationships.length;
  const metadata = metadataFor(entity);
  const step = useTableRowStep();
  return (
    <SidePanel
      label={`${entity} schema`}
      title={entity}
      icon={<EntityIcon entity={entity} className="size-5" />}
      code={schemaRow(entity, undefined).code ?? undefined}
      onClose={onClose}
      onPrev={() => step(-1)}
      onNext={() => step(1)}
    >
      <div className="space-y-4 p-3">
        {metadata.description && (
          <p className="text-xs text-muted-foreground">
            {metadata.description}
          </p>
        )}
        <div className="flex flex-wrap gap-1.5">
          <Link
            to="/entities/schema/$entity"
            params={{ entity }}
            className={buttonVariants({ variant: "outline", size: "sm" })}
          >
            Open schema page
          </Link>
          {isBrowserRoutedEntity(entity) && (
            <Link
              to={browserEntityDefinition(entity).routes.list}
              className={buttonVariants({ variant: "ghost", size: "sm" })}
            >
              Records
              <ArrowSquareOutIcon />
            </Link>
          )}
        </div>
        <SchemaFacts entity={entity} />
        <section className="space-y-1.5">
          <Heading title="Declaration overrides" count={overrides} />
          <Overrides entity={entity} />
        </section>
        <section className="space-y-1.5">
          <Heading title="Relations" count={relations} />
          <Relations entity={entity} target={panelTarget(onSelect)} />
        </section>
      </div>
    </SidePanel>
  );
}

/** The full schema page body: everything the panel shows, unabridged, plus
 * filters, detail sections, and saved views. */
export function EntitySchemaDetail({ entity }: { entity: Entity }) {
  const metadata = metadataFor(entity);
  return (
    <div className="space-y-6">
      <Identity entity={entity} />
      <SchemaFacts entity={entity} wide />
      <section className="space-y-1.5">
        <Heading
          title="Relations"
          count={extendedManifest(entity).relationships.length}
        />
        <Relations entity={entity} target={pageTarget} full />
      </section>
      <section className="space-y-1.5">
        <Heading
          title="Declaration overrides"
          count={overridesFor(entity).length}
        />
        <p className="text-2xs text-muted-foreground">
          Explicit *Override inputs in the entity manifest. Each comparison
          compiles the manifest with that input removed.
        </p>
        <Overrides entity={entity} full />
      </section>
      <div className="grid gap-6 lg:grid-cols-2">
        <section className="space-y-1.5">
          <Heading title="Filters" count={metadata.filterDescriptors.length} />
          <Filters entity={entity} />
        </section>
        <section className="space-y-1.5">
          <Heading
            title="Detail sections"
            count={metadata.detail.sections.length}
          />
          <DetailSectionsTable entity={entity} />
        </section>
      </div>
      <section className="space-y-1.5">
        <Heading title="Saved views" />
        <SavedViewChips entity={entity} />
      </section>
    </div>
  );
}
