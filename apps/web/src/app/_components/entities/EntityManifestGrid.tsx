import type { Entity } from "@cubby/schemas/entity";
import {
  allEntities,
  type EntityDescriptor,
  type EntityInspectorMetadata,
  entityInspectorMetadata,
  entityManifest,
  photoCategories,
} from "@cubby/schemas/entity-manifest";
import { LEGACY_SHORTCODE_PREFIX } from "@cubby/shared";
import { useQuery } from "@tanstack/react-query";
import { Fragment, type ReactNode } from "react";

import { Stack } from "~/components/layout";
import { Badge } from "~/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";
import {
  EntityIcon,
  browserEntityDefinition,
  isBrowserRoutedEntity,
} from "~/entities/entities";
import {
  type EntityInspectorHealth,
  entityInspectorHealth,
} from "~/entities/entity-inspector-health";
import { viewsForEntity } from "~/entities/view-manifest";
import { authClient } from "~/lib/auth-client";
import { ENTITY_NATIVE_COVERAGE } from "~/lib/generated/entity-native-coverage.gen";
import { cn } from "~/lib/utils";

import { EntityReferenceGraph } from "./EntityReferenceGraph";

const mono = "font-mono tabular-nums";
const dash = <span className="text-muted-foreground/40">—</span>;
const cellCls = "px-2 py-1";
const headCls = "h-6 px-2 py-1 text-[10px] leading-none";

function Chips({ items }: { items: readonly string[] }) {
  if (items.length === 0) return dash;
  return (
    <div className="flex flex-wrap gap-1">
      {items.map((item) => (
        <Badge key={item} variant="outline" className="font-mono text-2xs">
          {item}
        </Badge>
      ))}
    </div>
  );
}

export function SavedViewChips({ entity }: { entity: Entity }) {
  return <Chips items={viewsForEntity(entity).map((view) => view.label)} />;
}

/** A dense boolean marker: filled dot for `true`, faint mid-dot for `false`. */
function Dot({ value, title }: { value: boolean; title?: string }) {
  return (
    <span
      title={title}
      aria-label={value ? "yes" : "no"}
      className={value ? "text-foreground" : "text-muted-foreground/25"}
    >
      {value ? "●" : "·"}
    </span>
  );
}

/** A count, with the full item list in a `title` tooltip; a dash when empty. */
function CountTip({ items }: { items: readonly string[] }) {
  if (items.length === 0) return dash;
  return (
    <span className={mono} title={items.join(", ")}>
      {items.length}
    </span>
  );
}

function emittedCode(entity: Entity) {
  const prefix = metadataFor(entity).shortcodePrefix;
  return prefix ? `${prefix}XXXX` : null;
}

/**
 * `entityManifest[entity]`'s generated literal type omits an `optional()`
 * schema key entirely for an entity that leaves it unset, rather than typing
 * it `| undefined` — so a union-wide read of `relationships[i].derived` /
 * `.inverseOmit` doesn't type-check against every member. Widen back to the
 * zod-inferred shape, which `parsedEntityManifest` in `entity-manifest.ts`
 * already verifies every entry satisfies.
 */
function extendedManifest(entity: Entity): EntityDescriptor {
  // SAFETY: see doc comment above — `entityManifest[entity]` always
  // satisfies `entityDescriptor`, just not through a type TS can see here.
  return entityManifest[entity] as EntityDescriptor;
}

type Relationship = EntityDescriptor["relationships"][number];

/**
 * Same widening trap as `extendedManifest`, one level up: `entityInspectorMetadata[entity]`
 * indexed by the union `Entity` type collapses tuple-typed fields
 * (`kernelActions`, `detail.sections`, …) to `never` because each entity's
 * generated literal narrows them differently. Widen back to the exported
 * `EntityInspectorMetadata` shape.
 */
function metadataFor(entity: Entity): EntityInspectorMetadata {
  // SAFETY: see doc comment above — every entity's generated record already
  // satisfies `EntityInspectorMetadata`, just not through a type TS can see
  // when indexed by a union key.
  return entityInspectorMetadata[entity] as EntityInspectorMetadata;
}

/**
 * The inbound-only single-letter prefix a printed label may still carry. Not
 * a manifest fact: the parser's alias table in `@cubby/shared` is the only
 * place the legacy form survives.
 */
function legacyPrefix(entity: Entity): string | null {
  return (
    Object.entries(LEGACY_SHORTCODE_PREFIX).find(
      ([, target]) => target === entity,
    )?.[0] ?? null
  );
}

function acceptedCodes(entity: Entity) {
  return [metadataFor(entity).shortcodePrefix, legacyPrefix(entity)]
    .filter((prefix) => prefix !== null)
    .map((prefix) => `${prefix}XXXX`);
}

function printsLabels(entity: Entity): entity is "product" | "location" {
  return entity === "product" || entity === "location";
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="border-t border-border/70 pt-4">
      <h3 className="mb-2 font-mono text-xs tracking-wider text-muted-foreground uppercase">
        {title}
      </h3>
      {children}
    </section>
  );
}

function countFor(
  entity: Entity,
  counts: EntityInspectorHealth["counts"] | undefined,
) {
  if (!counts) return undefined;
  return entityManifest[entity].countable ? counts[entity] : undefined;
}

function PhotoCategoriesSection() {
  return (
    <Section title="Photo categories">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Category</TableHead>
            <TableHead>Entities</TableHead>
            <TableHead>Classifier labels (effective)</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {Object.values(photoCategories).map((category) => (
            <TableRow key={category.key}>
              <TableCell className="whitespace-nowrap">
                <span aria-hidden className="mr-1">
                  {category.emoji}
                </span>
                {category.label}
              </TableCell>
              <TableCell>
                <Chips items={category.entities} />
              </TableCell>
              <TableCell>
                <Chips items={category.classifierLabels} />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Section>
  );
}

function inspectorRoute(entity: Entity) {
  return isBrowserRoutedEntity(entity)
    ? browserEntityDefinition(entity).routes
    : null;
}

function mcpTransportLabel(entity: Entity) {
  const metadata = metadataFor(entity);
  return `${metadata.mcpOwner ?? "none"}: ${metadata.mcpOperations.join(", ") || "—"}`;
}

function routeCoverageLabel(entity: Entity) {
  const route = inspectorRoute(entity);
  return route ? `${route.list} · ${route.detail}` : "workflow-owned";
}

/** `list · get · update` plus a `+N rpc` suffix; a dash when the app never touches it. */
function nativeCoverageLabel(entity: Entity): string {
  const coverage = ENTITY_NATIVE_COVERAGE[entity];
  const actions = coverage.httpActions.join(" · ");
  const rpc = coverage.rpcIds.length ? `+${coverage.rpcIds.length} rpc` : "";
  const label = [actions, rpc].filter(Boolean).join(" ");
  return label || "—";
}

/**
 * Kernel actions condensed to a fixed-position `CRUD` letter mask — `C`
 * (create), `R` (both `get` and `list`), `U` (update), `D` (delete) — plus
 * any extra action (`search`, `bulkUpdate`, `merge`) as a `+name` suffix. All
 * four slots present renders as the plain word `CRUD`.
 */
type KernelAction = EntityInspectorMetadata["kernelActions"][number];

const CRUD_SLOTS = [
  { code: "C", needs: ["create"] },
  { code: "R", needs: ["get", "list"] },
  { code: "U", needs: ["update"] },
  { code: "D", needs: ["delete"] },
] as const satisfies readonly {
  code: string;
  needs: readonly KernelAction[];
}[];
const CRUD_KNOWN_ACTIONS = new Set<KernelAction>(
  CRUD_SLOTS.flatMap((slot) => slot.needs),
);

function kernelActionsLabel(entity: Entity) {
  const actions = metadataFor(entity).kernelActions;
  const mask = CRUD_SLOTS.map((slot) =>
    slot.needs.every((need) => actions.includes(need)) ? slot.code : "·",
  ).join("");
  return {
    mask,
    full: mask === "CRUD",
    extras: actions.filter((action) => !CRUD_KNOWN_ACTIONS.has(action)),
  };
}

function KernelActionsCell({ entity }: { entity: Entity }) {
  const { mask, full, extras } = kernelActionsLabel(entity);
  return (
    <span className={cn("whitespace-nowrap", mono)}>
      <span className={full ? "text-muted-foreground" : undefined}>{mask}</span>
      {extras.length > 0 && (
        <span className="ml-1 text-muted-foreground">
          {extras.map((extra) => `+${extra}`).join(" ")}
        </span>
      )}
    </span>
  );
}

function idFilterCount(entity: Entity) {
  return metadataFor(entity).filterDescriptors.filter(
    (filter) => filter.kind === "id" || filter.kind === "idMulti",
  ).length;
}

function cardinalitySplit(entity: Entity) {
  const relationships = extendedManifest(entity).relationships;
  const one = relationships.filter(
    (relation) => relation.cardinality === "one",
  ).length;
  return { one, many: relationships.length - one };
}

type RelationDetailStatus =
  | "declared"
  | "derived"
  | "omitted"
  | "no-list"
  | "one";

/** Compiler auto-omit reasons end with this sentence — the target simply has
 * no list page to render as a table, distinct from a hand-declared omission. */
const NO_LIST_SUFFIX = "has no list page to render as a table.";

const DETAIL_STATUS_LABEL = {
  declared: "declared",
  derived: "derived",
  omitted: "omitted",
  "no-list": "no list",
  one: "—",
} satisfies Record<RelationDetailStatus, string>;

type RelationDetail = {
  status: RelationDetailStatus;
  reason?: string;
  descriptor?: string;
};

/**
 * Where a relation's detail table stands, per the compiled `detail` block:
 * `one`-cardinality relations never get a table (only `inverseOmit` explains
 * why no inverse exists); a `many` relation is `declared` when a hand-written
 * `kind:"relation"` section names it, `derived` when the compiler generated
 * that section, or `omitted`/`no-list` when `detail.omitRelations` records
 * why no section exists at all.
 */
function relationDetailStatus(
  entity: Entity,
  relation: Relationship,
): RelationDetail {
  if (relation.cardinality === "one") {
    return { status: "one", reason: relation.inverseOmit };
  }
  const { sections, omitRelations } = metadataFor(entity).detail;
  const section = sections.find(
    (candidate) =>
      candidate.kind === "relation" && candidate.relation === relation.key,
  );
  if (section && section.kind === "relation") {
    return {
      status: section.derived ? "derived" : "declared",
      descriptor: section.filter.descriptor,
    };
  }
  const reason = omitRelations[relation.key];
  if (reason) {
    return {
      status: reason.endsWith(NO_LIST_SUFFIX) ? "no-list" : "omitted",
      reason,
    };
  }
  return {
    status: "omitted",
    reason: "not declared, not recorded as omitted",
  };
}

function manyDetailTally(entity: Entity) {
  const relationships = extendedManifest(entity).relationships.filter(
    (relation) => relation.cardinality === "many",
  );
  let declared = 0;
  let derived = 0;
  let omitted = 0;
  for (const relation of relationships) {
    const { status } = relationDetailStatus(entity, relation);
    if (status === "declared") declared += 1;
    else if (status === "derived") derived += 1;
    else omitted += 1;
  }
  return { declared, derived, omitted, total: relationships.length };
}

/** The value most entities share for a column — the rendering caller mutes
 * this value and leaves outliers at normal weight, so a scan of the column
 * finds the exceptions instead of rereading the norm 24 times. */
function mostCommon<T extends string>(values: readonly T[]): T {
  const counts = new Map<T, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  // SAFETY: every caller passes `allEntities.map(...)`, which is always
  // non-empty, so `values[0]` is always a `T`, never `undefined`.
  let best = values[0] as T;
  let bestCount = 0;
  for (const [value, count] of counts) {
    if (count > bestCount) {
      best = value;
      bestCount = count;
    }
  }
  return best;
}

const MODAL_MCP_OWNER = mostCommon(
  allEntities.map((entity) => metadataFor(entity).mcpOwner ?? "none"),
);
const MODAL_DETAIL_VARIANT = mostCommon(
  allEntities.map((entity) => metadataFor(entity).detail.variant),
);

/** `shortcodePrefix` without its trailing dash, already a stable 3-4 letter
 * abbreviation the rest of the app uses — reused here as the matrix's
 * column/row header instead of inventing a second abbreviation scheme. */
function abbrev(entity: Entity): string {
  const prefix = metadataFor(entity).shortcodePrefix;
  return prefix ? prefix.replace(/-$/, "") : entity.slice(0, 4).toUpperCase();
}

function matrixStatusClass(status: RelationDetailStatus): string {
  switch (status) {
    case "declared":
      return "text-foreground";
    case "derived":
      return "text-primary";
    case "omitted":
      return "text-destructive";
    case "no-list":
      return "text-muted-foreground/50";
    case "one":
      return "text-muted-foreground/30";
  }
}

const MATRIX_LEGEND: readonly [RelationDetailStatus, string][] = [
  ["declared", "declared detail table"],
  ["derived", "compiler-derived detail table"],
  ["omitted", "explicitly omitted"],
  ["no-list", "target has no list page"],
  ["one", "one-cardinality (no table)"],
];

/** Entity × entity relation coverage. Rows are the relation's source, columns
 * its target; each dot is one declared relationship, colored by whether its
 * detail table is declared, derived, or missing — the place coverage gaps
 * stay visible at a glance instead of hiding in 24 separate detail views. */
function RelationsMatrix() {
  return (
    <div className="space-y-1">
      <Table
        containerClassName="border-y"
        className="w-max table-auto text-[10px]"
      >
        <TableHeader>
          <TableRow>
            <TableHead
              className={cn(headCls, "sticky top-0 left-0 z-20 bg-muted")}
            >
              from \ to
            </TableHead>
            {allEntities.map((target) => (
              <TableHead
                key={target}
                title={target}
                className={cn(
                  headCls,
                  "sticky top-0 z-10 bg-muted text-center",
                )}
              >
                {abbrev(target)}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {allEntities.map((source) => (
            <TableRow key={source}>
              <TableCell
                title={source}
                className={cn(
                  cellCls,
                  "sticky left-0 z-10 bg-background font-mono",
                )}
              >
                {abbrev(source)}
              </TableCell>
              {allEntities.map((target) => {
                const relations = extendedManifest(source).relationships.filter(
                  (relation) => relation.target === target,
                );
                if (relations.length === 0) {
                  return (
                    <TableCell
                      key={target}
                      className={cn(
                        cellCls,
                        "text-center text-muted-foreground/15",
                      )}
                    >
                      ·
                    </TableCell>
                  );
                }
                const details = relations.map((relation) => ({
                  relation,
                  detail: relationDetailStatus(source, relation),
                }));
                const title = details
                  .map(
                    ({ relation, detail }) =>
                      `${relation.key}: ${detail.status}${detail.reason ? ` — ${detail.reason}` : ""}`,
                  )
                  .join("\n");
                return (
                  <TableCell
                    key={target}
                    title={title}
                    className={cn(cellCls, "text-center")}
                  >
                    {details.map(({ relation, detail }) => (
                      <span
                        key={relation.key}
                        className={cn(
                          "mx-px",
                          matrixStatusClass(detail.status),
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
      <div className="flex flex-wrap gap-3 px-1 text-2xs text-muted-foreground">
        {MATRIX_LEGEND.map(([status, label]) => (
          <span key={status} className="inline-flex items-center gap-1">
            <span className={matrixStatusClass(status)}>●</span> {label}
          </span>
        ))}
      </div>
    </div>
  );
}

/** The expanded sub-row: every declared relationship for one entity, dense
 * enough to read origin (declared vs. compiler-derived) and detail-table
 * coverage without opening a second page. */
function RelationsSubRow({ entity }: { entity: Entity }) {
  const relationships = extendedManifest(entity).relationships;
  if (relationships.length === 0) {
    return (
      <TableRow className="bg-muted/20 hover:bg-muted/20">
        <TableCell
          colSpan={COLUMN_COUNT}
          className="px-4 py-2 text-2xs text-muted-foreground italic"
        >
          {entity} declares no relations.
        </TableCell>
      </TableRow>
    );
  }
  return (
    <TableRow className="bg-muted/20 hover:bg-muted/20">
      <TableCell colSpan={COLUMN_COUNT} className="p-0">
        <Table className="w-full table-auto text-2xs">
          <TableHeader>
            <TableRow>
              <TableHead className={headCls}>Key</TableHead>
              <TableHead className={headCls}>Target</TableHead>
              <TableHead className={headCls}>Cardinality</TableHead>
              <TableHead className={headCls}>Origin</TableHead>
              <TableHead className={headCls}>Detail table</TableHead>
              <TableHead className={headCls}>Filter</TableHead>
              <TableHead className={headCls}>Notes</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {relationships.map((relation) => {
              const detail = relationDetailStatus(entity, relation);
              return (
                <TableRow key={relation.key}>
                  <TableCell className={cn(cellCls, "font-mono")}>
                    {relation.key}
                  </TableCell>
                  <TableCell className={cn(cellCls, "font-mono")}>
                    {relation.target}
                  </TableCell>
                  <TableCell className={cellCls}>
                    {relation.cardinality}
                  </TableCell>
                  <TableCell className={cellCls}>
                    {relation.derived ? "derived" : "declared"}
                  </TableCell>
                  <TableCell
                    title={detail.reason}
                    className={cn(cellCls, matrixStatusClass(detail.status))}
                  >
                    {DETAIL_STATUS_LABEL[detail.status]}
                  </TableCell>
                  <TableCell className={cn(cellCls, "font-mono")}>
                    {detail.descriptor ?? dash}
                  </TableCell>
                  <TableCell
                    className={cn(cellCls, "max-w-md text-muted-foreground")}
                  >
                    {detail.reason ?? relation.label}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </TableCell>
    </TableRow>
  );
}
const COLUMN_COUNT = 20; // entity + 19 data columns (see the two header rows below)

/**
 * One row per entity, grouped columns, sticky header and first column,
 * `text-[11px]` throughout. Replaces the old `ComparisonMatrix` plus the
 * separate per-entity detail cards: clicking a row expands a dense relations
 * sub-table in place instead of navigating to a second view. Reuses the
 * `selected` / `onSelect` props as the (always-one-expanded) row so deep
 * links keep working.
 */
function MegaTable({
  selected,
  counts,
  onSelect,
}: {
  selected: Entity;
  counts: EntityInspectorHealth["counts"] | undefined;
  onSelect: (entity: Entity) => void;
}) {
  return (
    <div>
      <Table
        containerClassName="border-y"
        className="w-max table-auto text-[11px]"
      >
        <TableHeader>
          <TableRow>
            <TableHead
              rowSpan={2}
              className={cn(
                headCls,
                "sticky top-0 left-0 z-30 bg-muted align-bottom",
              )}
            >
              Entity
            </TableHead>
            <TableHead
              colSpan={4}
              className={cn(headCls, "sticky top-0 z-10 bg-muted text-center")}
            >
              Identity
            </TableHead>
            <TableHead
              colSpan={1}
              className={cn(headCls, "sticky top-0 z-10 bg-muted text-center")}
            >
              Kernel
            </TableHead>
            <TableHead
              colSpan={2}
              className={cn(headCls, "sticky top-0 z-10 bg-muted text-center")}
            >
              Filters
            </TableHead>
            <TableHead
              colSpan={1}
              className={cn(headCls, "sticky top-0 z-10 bg-muted text-center")}
            >
              Search
            </TableHead>
            <TableHead
              colSpan={2}
              className={cn(headCls, "sticky top-0 z-10 bg-muted text-center")}
            >
              Relations
            </TableHead>
            <TableHead
              colSpan={2}
              className={cn(headCls, "sticky top-0 z-10 bg-muted text-center")}
            >
              Lifecycle
            </TableHead>
            <TableHead
              colSpan={3}
              className={cn(headCls, "sticky top-0 z-10 bg-muted text-center")}
            >
              Transports / MCP
            </TableHead>
            <TableHead
              colSpan={2}
              className={cn(headCls, "sticky top-0 z-10 bg-muted text-center")}
            >
              Presentation
            </TableHead>
            <TableHead
              colSpan={1}
              className={cn(headCls, "sticky top-0 z-10 bg-muted text-center")}
            >
              Native
            </TableHead>
            <TableHead
              colSpan={1}
              className={cn(headCls, "sticky top-0 z-10 bg-muted text-center")}
            >
              Labels
            </TableHead>
          </TableRow>
          <TableRow>
            <TableHead className={cn(headCls, "sticky top-6 z-10 bg-muted")}>
              Code
            </TableHead>
            <TableHead className={cn(headCls, "sticky top-6 z-10 bg-muted")}>
              Aliases
            </TableHead>
            <TableHead className={cn(headCls, "sticky top-6 z-10 bg-muted")}>
              Table
            </TableHead>
            <TableHead className={cn(headCls, "sticky top-6 z-10 bg-muted")}>
              Rows
            </TableHead>
            <TableHead className={cn(headCls, "sticky top-6 z-10 bg-muted")}>
              Actions
            </TableHead>
            <TableHead className={cn(headCls, "sticky top-6 z-10 bg-muted")}>
              Filters
            </TableHead>
            <TableHead className={cn(headCls, "sticky top-6 z-10 bg-muted")}>
              ID
            </TableHead>
            <TableHead className={cn(headCls, "sticky top-6 z-10 bg-muted")}>
              Search
            </TableHead>
            <TableHead className={cn(headCls, "sticky top-6 z-10 bg-muted")}>
              1:N
            </TableHead>
            <TableHead className={cn(headCls, "sticky top-6 z-10 bg-muted")}>
              Detail
            </TableHead>
            <TableHead className={cn(headCls, "sticky top-6 z-10 bg-muted")}>
              Delete
            </TableHead>
            <TableHead className={cn(headCls, "sticky top-6 z-10 bg-muted")}>
              Merge
            </TableHead>
            <TableHead className={cn(headCls, "sticky top-6 z-10 bg-muted")}>
              MCP
            </TableHead>
            <TableHead className={cn(headCls, "sticky top-6 z-10 bg-muted")}>
              Owner
            </TableHead>
            <TableHead className={cn(headCls, "sticky top-6 z-10 bg-muted")}>
              Routes
            </TableHead>
            <TableHead className={cn(headCls, "sticky top-6 z-10 bg-muted")}>
              Variant
            </TableHead>
            <TableHead className={cn(headCls, "sticky top-6 z-10 bg-muted")}>
              Sect.
            </TableHead>
            <TableHead className={cn(headCls, "sticky top-6 z-10 bg-muted")}>
              Native
            </TableHead>
            <TableHead className={cn(headCls, "sticky top-6 z-10 bg-muted")}>
              Print
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {allEntities.map((entity) => {
            const metadata = metadataFor(entity);
            const isSelected = selected === entity;
            const { one, many } = cardinalitySplit(entity);
            const tally = manyDetailTally(entity);
            const routed = isBrowserRoutedEntity(entity);
            return (
              <Fragment key={entity}>
                <TableRow
                  data-state={isSelected ? "selected" : undefined}
                  className="cursor-pointer"
                  onClick={() => onSelect(entity)}
                >
                  <TableCell
                    className={cn(
                      cellCls,
                      "sticky left-0 z-10 bg-background font-mono",
                    )}
                  >
                    <span className="inline-flex items-center gap-1.5">
                      <EntityIcon entity={entity} className="size-3.5" />
                      {entity}
                    </span>
                  </TableCell>
                  <TableCell className={cn(cellCls, mono)}>
                    {emittedCode(entity) ?? dash}
                  </TableCell>
                  <TableCell className={cellCls}>
                    <CountTip items={acceptedCodes(entity).slice(1)} />
                  </TableCell>
                  <TableCell className={cn(cellCls, "font-mono")}>
                    {entityManifest[entity].dbTable ?? dash}
                  </TableCell>
                  <TableCell className={cn(cellCls, mono)}>
                    {countFor(entity, counts) ?? dash}
                  </TableCell>
                  <TableCell className={cellCls}>
                    <KernelActionsCell entity={entity} />
                  </TableCell>
                  <TableCell className={cn(cellCls, mono)}>
                    {metadata.filterDescriptors.length}
                  </TableCell>
                  <TableCell className={cn(cellCls, mono)}>
                    {idFilterCount(entity) || (
                      <span className="text-muted-foreground/30">0</span>
                    )}
                  </TableCell>
                  <TableCell className={cellCls}>
                    <Dot
                      value={metadata.searchable}
                      title={
                        metadata.searchable
                          ? "lexical + semantic search"
                          : "not searchable"
                      }
                    />
                  </TableCell>
                  <TableCell
                    className={cn(cellCls, mono)}
                    title={`${one} one-cardinality · ${many} many-cardinality`}
                  >
                    {one}/{many}
                  </TableCell>
                  <TableCell
                    className={cn(cellCls, mono)}
                    title={`${tally.declared} declared · ${tally.derived} derived · ${tally.omitted} omitted (of ${tally.total} many-relations)`}
                  >
                    {tally.total === 0
                      ? dash
                      : `${tally.declared}/${tally.derived}/${tally.omitted}`}
                  </TableCell>
                  <TableCell className={cellCls}>
                    {metadata.lifecycle.delete?.mode ?? dash}
                  </TableCell>
                  <TableCell className={cellCls}>
                    <Dot value={metadata.lifecycle.merge} />
                  </TableCell>
                  <TableCell
                    className={cn(cellCls, mono)}
                    title={mcpTransportLabel(entity)}
                  >
                    {metadata.mcpOperations.length}
                  </TableCell>
                  <TableCell
                    className={cn(
                      cellCls,
                      (metadata.mcpOwner ?? "none") === MODAL_MCP_OWNER &&
                        "text-muted-foreground",
                    )}
                  >
                    {metadata.mcpOwner ?? "none"}
                  </TableCell>
                  <TableCell className={cellCls}>
                    <Dot value={routed} title={routeCoverageLabel(entity)} />
                  </TableCell>
                  <TableCell
                    className={cn(
                      cellCls,
                      metadata.detail.variant === MODAL_DETAIL_VARIANT &&
                        "text-muted-foreground",
                    )}
                  >
                    {metadata.detail.variant}
                  </TableCell>
                  <TableCell className={cn(cellCls, mono)}>
                    {metadata.detail.sections.length}
                  </TableCell>
                  <TableCell
                    className={cn(cellCls, "max-w-[14rem] truncate")}
                    title={nativeCoverageLabel(entity)}
                  >
                    {nativeCoverageLabel(entity)}
                  </TableCell>
                  <TableCell className={cellCls}>
                    <Dot value={printsLabels(entity)} />
                  </TableCell>
                </TableRow>
                {isSelected && <RelationsSubRow entity={entity} />}
              </Fragment>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

export function EntityManifestGrid({
  selected,
  onSelect,
  active = true,
}: {
  selected: Entity;
  onSelect: (entity: Entity) => void;
  active?: boolean;
}) {
  const session = authClient.useSession();
  const { data: health } = useQuery({
    ...entityInspectorHealth.inspectorHealth.queryOptions(null),
    enabled: active && !!session.data?.user,
  });
  const counts = health?.counts;
  const crudCount = allEntities.filter(
    (entity) => metadataFor(entity).kernelActions.length > 0,
  ).length;
  const searchCount = allEntities.filter(
    (entity) => metadataFor(entity).searchable,
  ).length;
  const mcpCount = allEntities.filter(
    (entity) => metadataFor(entity).mcpOperations.length > 0,
  ).length;
  const explicitPortCount = allEntities.filter(
    (entity) => metadataFor(entity).ports.repository !== null,
  ).length;

  return (
    <Stack gap="lg">
      <div className="border-y bg-muted/20 px-4 py-4 font-mono text-xs">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span>literal entity spec</span>
          <span aria-hidden>→</span>
          <span>generated contracts and bindings</span>
          <span aria-hidden>→</span>
          <span className="text-primary">executeEntity</span>
          <span aria-hidden>→</span>
          <span>Start entities / workflow streams / MCP adapters</span>
          <span aria-hidden>→</span>
          <span>routes, pages, search, lifecycle</span>
        </div>
      </div>

      <div className="grid border-y sm:grid-cols-2 lg:grid-cols-6">
        {[
          ["Declared", allEntities.length],
          ["Generic CRUD", crudCount],
          ["Search + embed", searchCount],
          ["MCP exposed", mcpCount],
          ["Explicit ports", explicitPortCount],
          ["QR compatibility", "P- · L-"],
        ].map(([label, value]) => (
          <div
            key={label}
            className="border-b border-border/60 px-4 py-2 lg:border-r lg:border-b-0"
          >
            <div className="text-xs text-muted-foreground">{label}</div>
            <div className="font-mono text-lg tabular-nums">{value}</div>
          </div>
        ))}
      </div>

      <MegaTable selected={selected} counts={counts} onSelect={onSelect} />

      <Section title="Relations matrix">
        <RelationsMatrix />
      </Section>

      <PhotoCategoriesSection />
      <Section title="Reference graph">
        <EntityReferenceGraph />
      </Section>
    </Stack>
  );
}
