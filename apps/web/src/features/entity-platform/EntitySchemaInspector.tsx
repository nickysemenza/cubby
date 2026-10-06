import type { Entity } from "@cubby/schemas/entity";
import { ArrowSquareOutIcon } from "@phosphor-icons/react/dist/csr/ArrowSquareOut";
import { XIcon } from "@phosphor-icons/react/dist/csr/X";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

import {
  EntityIcon,
  browserEntityDefinition,
  isBrowserRoutedEntity,
} from "~/entity/entities";
import { viewsForEntity } from "~/entity/view-manifest";
import { cn } from "~/lib/utils";
import { domainWayfinding } from "~/ui/navigation/domain-wayfinding";
import { Badge } from "~/ui/primitives/badge";
import { buttonVariants } from "~/ui/primitives/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/ui/primitives/table";

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
  "h-7 border-b border-border bg-muted px-2 text-left text-2xs font-medium text-muted-foreground";

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
    <h3 className="flex items-baseline gap-2 text-xs font-semibold">
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
function Facts({ entity, wide }: { entity: Entity; wide?: boolean }) {
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
    ["Domain", row.domain ? domainWayfinding(row.domain).label : "none"],
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
    ["Search", row.searchable ? "lexical + semantic" : "no"],
    [
      "Delete / merge",
      `${row.deleteMode ?? "none"} · ${row.merge ? "merge" : "no merge"}`,
    ],
    [
      "MCP",
      `${row.mcpOwner ?? "none"} · ${row.mcpOperations.join(", ") || "no operations"}`,
    ],
    ["Native app", row.native ?? dash],
    [
      "Repository port",
      repository ? `${repository.module}#${repository.export}` : "generic",
    ],
    [
      "Printed labels",
      entity === "product" || entity === "location" ? "yes" : "no",
    ],
  ];
  return (
    <dl
      className={cn(
        "grid border-t border-border/60 text-xs",
        wide && "lg:grid-cols-2 lg:gap-x-6",
      )}
    >
      {facts.map(([label, value]) => (
        <div
          key={label}
          className="grid grid-cols-[8rem_minmax(0,1fr)] gap-2 border-b border-border/60 py-1"
        >
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="min-w-0 font-mono text-2xs/5 break-words">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function OutcomeBadge({ status }: { status: OverrideComparison["status"] }) {
  if (status === "invalid")
    return (
      <Badge variant="destructive" className="text-2xs">
        invalid default
      </Badge>
    );
  if (status === "changed")
    return (
      <Badge variant="outline" className="text-2xs">
        changed
      </Badge>
    );
  return (
    <Badge variant="warning" className="text-2xs">
      unchanged
    </Badge>
  );
}

function Overrides({ entity, full }: { entity: Entity; full?: boolean }) {
  const overrides = overridesFor(entity);
  if (overrides.length === 0)
    return (
      <p className="text-xs text-muted-foreground">No overrides declared.</p>
    );
  if (!full)
    return (
      <ul className="border-t border-border/60 text-xs">
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
    <Table className="w-full table-fixed border-collapse text-xs">
      <TableHeader>
        <TableRow>
          <TableHead className={cn(head, "w-[26%]")}>Override path</TableHead>
          <TableHead className={cn(head, "w-[30%]")}>Declared</TableHead>
          <TableHead className={cn(head, "w-[30%]")}>
            Without override
          </TableHead>
          <TableHead className={cn(head, "w-[14%]")}>Outcome</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {overrides.map((override) => (
          <TableRow key={override.path}>
            <TableCell className={cn(cell, "font-mono text-2xs break-all")}>
              {override.path}
            </TableCell>
            <TableCell className={cell}>
              <pre className="max-h-48 overflow-auto font-mono text-2xs break-all whitespace-pre-wrap">
                {override.declared}
              </pre>
            </TableCell>
            <TableCell className={cell}>
              {override.without === null ? (
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
              )}
            </TableCell>
            <TableCell className={cell}>
              <OutcomeBadge status={override.status} />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
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
    <Table className="w-full table-auto border-collapse text-2xs">
      <TableHeader>
        <TableRow>
          <TableHead className={head}>Key</TableHead>
          <TableHead className={head}>Target</TableHead>
          <TableHead className={head} title="Cardinality">
            Card.
          </TableHead>
          {full && <TableHead className={head}>Origin</TableHead>}
          <TableHead className={head}>Detail table</TableHead>
          {full && <TableHead className={head}>Filter</TableHead>}
          {full && <TableHead className={head}>Notes</TableHead>}
        </TableRow>
      </TableHeader>
      <TableBody>
        {relationships.map((relation) => {
          const detail = relationDetailStatus(entity, relation);
          return (
            <TableRow key={relation.key}>
              <TableCell className={cn(cell, "font-mono")}>
                {relation.key}
              </TableCell>
              <TableCell className={cell}>{target(relation.target)}</TableCell>
              <TableCell className={cell}>{relation.cardinality}</TableCell>
              {full && (
                <TableCell className={cell}>
                  {relation.derived ? "derived" : "declared"}
                </TableCell>
              )}
              <TableCell
                title={detail.reason}
                className={cn(cell, relationStatusClass(detail.status))}
              >
                {DETAIL_STATUS_LABEL[detail.status]}
              </TableCell>
              {full && (
                <TableCell className={cn(cell, "font-mono")}>
                  {detail.descriptor ?? dash}
                </TableCell>
              )}
              {full && (
                <TableCell className={cn(cell, "text-muted-foreground")}>
                  {detail.reason ?? relation.label}
                </TableCell>
              )}
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

function Filters({ entity }: { entity: Entity }) {
  const filters = metadataFor(entity).filterDescriptors;
  if (filters.length === 0)
    return <p className="text-xs text-muted-foreground">No filters.</p>;
  return (
    <Table className="w-full table-auto border-collapse text-2xs">
      <TableHeader>
        <TableRow>
          <TableHead className={head}>URL key</TableHead>
          <TableHead className={head}>Kind</TableHead>
          <TableHead className={head}>Field</TableHead>
          <TableHead className={head}>Label</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {filters.map((filter) => (
          <TableRow key={filter.urlKey}>
            <TableCell className={cn(cell, "font-mono")}>
              {filter.urlKey}
            </TableCell>
            <TableCell className={cn(cell, "font-mono")}>
              {filter.kind}
            </TableCell>
            <TableCell className={cn(cell, "font-mono")}>
              {filter.field ?? dash}
            </TableCell>
            <TableCell className={cell}>{filter.label ?? dash}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function DetailSectionsTable({ entity }: { entity: Entity }) {
  const sections = metadataFor(entity).detail.sections;
  return (
    <Table className="w-full table-auto border-collapse text-2xs">
      <TableHeader>
        <TableRow>
          <TableHead className={head}>Section</TableHead>
          <TableHead className={head}>Kind</TableHead>
          <TableHead className={head}>Title</TableHead>
          <TableHead className={head}>Placement</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {sections.map((section) => (
          <TableRow key={section.id}>
            <TableCell className={cn(cell, "font-mono")}>
              {section.id}
            </TableCell>
            <TableCell className={cn(cell, "font-mono")}>
              {section.kind}
            </TableCell>
            <TableCell className={cell}>{section.title ?? dash}</TableCell>
            <TableCell className={cell}>{section.placement}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function Identity({ entity }: { entity: Entity }) {
  const metadata = metadataFor(entity);
  return (
    <div className="flex min-w-0 items-start gap-2">
      <EntityIcon entity={entity} colored className="mt-1 size-5 shrink-0" />
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
  return (
    <section aria-label={`${entity} schema`} className="space-y-4 p-3">
      <div className="flex items-start justify-between gap-2">
        <Identity entity={entity} />
        <button
          type="button"
          aria-label="Close panel"
          onClick={onClose}
          className={buttonVariants({ variant: "ghost", size: "icon-sm" })}
        >
          <XIcon />
        </button>
      </div>
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
      <Facts entity={entity} />
      <section className="space-y-1.5">
        <Heading title="Declaration overrides" count={overrides} />
        <Overrides entity={entity} />
      </section>
      <section className="space-y-1.5">
        <Heading title="Relations" count={relations} />
        <Relations entity={entity} target={panelTarget(onSelect)} />
      </section>
    </section>
  );
}

/** The full schema page body: everything the panel shows, unabridged, plus
 * filters, detail sections, and saved views. */
export function EntitySchemaDetail({ entity }: { entity: Entity }) {
  const metadata = metadataFor(entity);
  return (
    <div className="space-y-6">
      <Identity entity={entity} />
      <Facts entity={entity} wide />
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
