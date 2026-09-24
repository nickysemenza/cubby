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
import { CaretDownIcon as ChevronDown } from "@phosphor-icons/react/dist/csr/CaretDown";
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
import { entityDeclarationOverrides } from "~/entities/generated/entity-overrides.gen";
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

function overridesFor(
  entity: Entity,
): readonly { path: string; value: string }[] {
  return entityDeclarationOverrides[entity];
}

function legacyPrefix(entity: Entity): string | null {
  return (
    Object.entries(LEGACY_SHORTCODE_PREFIX).find(
      ([, target]) => target === entity,
    )?.[0] ?? null
  );
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

function mcpTransportLabel(entity: Entity) {
  const metadata = metadataFor(entity);
  return `${metadata.mcpOwner ?? "none"}: ${metadata.mcpOperations.join(", ") || "—"}`;
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

function cardinalitySplit(entity: Entity) {
  const relationships = extendedManifest(entity).relationships;
  const one = relationships.filter(
    (relation) => relation.cardinality === "one",
  ).length;
  return { one, many: relationships.length - one };
}

function idFilterCount(entity: Entity) {
  return metadataFor(entity).filterDescriptors.filter(
    (filter) => filter.kind === "id" || filter.kind === "idMulti",
  ).length;
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
  const tally = { declared: 0, derived: 0, omitted: 0 };
  for (const relation of relationships) {
    const { status } = relationDetailStatus(entity, relation);
    if (status === "declared") tally.declared += 1;
    else if (status === "derived") tally.derived += 1;
    else tally.omitted += 1;
  }
  return tally;
}

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
      <TableCell colSpan={COLUMN_COUNT} className="px-4 py-3">
        <div className="max-w-5xl">
          <h3 className="mb-2 text-xs font-semibold">Relations</h3>
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
        </div>
      </TableCell>
    </TableRow>
  );
}
const COLUMN_COUNT = 9;

function OverrideValue({ value }: { value: string }) {
  if (value.length <= 120)
    return (
      <code className="font-mono break-all whitespace-normal">{value}</code>
    );
  const parsed: unknown = JSON.parse(value);
  const label = Array.isArray(parsed)
    ? `${parsed.length} entries`
    : "Show value";
  return (
    <details>
      <summary className="w-fit cursor-pointer text-primary hover:underline">
        {label}
      </summary>
      <pre className="mt-1 max-h-80 overflow-auto font-mono text-2xs break-all whitespace-pre-wrap">
        {JSON.stringify(parsed, null, 2)}
      </pre>
    </details>
  );
}

function EffectiveBehavior({ entity }: { entity: Entity }) {
  const metadata = metadataFor(entity);
  const tally = manyDetailTally(entity);
  const route = isBrowserRoutedEntity(entity)
    ? browserEntityDefinition(entity).routes
    : null;
  const facts: readonly [string, ReactNode][] = [
    [
      "Legacy code",
      legacyPrefix(entity) ? `${legacyPrefix(entity)}XXXX` : dash,
    ],
    ["Storage table", entityManifest[entity].dbTable ?? dash],
    [
      "Filters",
      `${metadata.filterDescriptors.length} total · ${idFilterCount(entity)} ID`,
    ],
    [
      "Relation tables",
      `${tally.declared} declared · ${tally.derived} derived · ${tally.omitted} omitted`,
    ],
    [
      "Delete / merge",
      `${metadata.lifecycle.delete?.mode ?? "none"} · ${metadata.lifecycle.merge ? "merge" : "no merge"}`,
    ],
    [
      "MCP",
      `${metadata.mcpOwner ?? "none"} · ${metadata.mcpOperations.join(", ") || "no operations"}`,
    ],
    ["Routes", route ? `${route.list} · ${route.detail}` : "workflow owned"],
    [
      "Detail",
      `${metadata.detail.variant} · ${metadata.detail.sections.length} sections`,
    ],
    [
      "Printed labels",
      entity === "product" || entity === "location" ? "yes" : "no",
    ],
  ];
  return (
    <section>
      <h3 className="mb-2 text-xs font-semibold">Effective behavior</h3>
      <dl className="grid gap-x-5 gap-y-2 text-xs sm:grid-cols-2 lg:grid-cols-3">
        {facts.map(([label, value]) => (
          <div key={label} className="min-w-0">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="min-w-0 break-all">{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function OverridesSubRow({ entity }: { entity: Entity }) {
  const overrides = overridesFor(entity);
  return (
    <TableRow className="bg-muted/20 hover:bg-muted/20">
      <TableCell colSpan={COLUMN_COUNT} className="px-4 py-3 whitespace-normal">
        <div id={`entity-details-${entity}`} className="max-w-5xl space-y-4">
          <EffectiveBehavior entity={entity} />
          <div>
            <h3 className="text-xs font-semibold">Declaration overrides</h3>
            <p className="text-2xs text-muted-foreground">
              Explicit *Override inputs in the entity manifest. Generated
              defaults are omitted.
            </p>
          </div>
          {overrides.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No overrides declared.
            </p>
          ) : (
            <dl className="divide-y divide-border/60 border-y border-border/60 text-xs">
              {overrides.map(({ path, value }) => (
                <div
                  key={path}
                  className="grid gap-1 py-1.5 md:grid-cols-[minmax(14rem,2fr)_minmax(0,3fr)] md:gap-4"
                >
                  <dt className="min-w-0 font-mono break-all text-muted-foreground">
                    {path}
                  </dt>
                  <dd className="min-w-0 whitespace-normal">
                    <OverrideValue value={value} />
                  </dd>
                </div>
              ))}
            </dl>
          )}
        </div>
      </TableCell>
    </TableRow>
  );
}

/** A compact scan of effective capabilities; the selected row holds the full
 * declaration exceptions and relationship inventory. */
function MegaTable({
  selected,
  counts,
  onSelect,
}: {
  selected: Entity | null;
  counts: EntityInspectorHealth["counts"] | undefined;
  onSelect: (entity: Entity | null) => void;
}) {
  return (
    <Table
      containerClassName="border-y"
      className="w-full min-w-[48rem] table-auto text-xs"
    >
      <TableHeader>
        <TableRow>
          <TableHead className={cn(headCls, "sticky left-0 z-10 bg-muted")}>
            Entity
          </TableHead>
          <TableHead className={headCls}>Code</TableHead>
          <TableHead className={headCls}>Rows</TableHead>
          <TableHead className={headCls}>Actions</TableHead>
          <TableHead className={headCls}>Search</TableHead>
          <TableHead className={headCls}>Relations</TableHead>
          <TableHead className={headCls}>MCP</TableHead>
          <TableHead className={headCls}>Overrides</TableHead>
          <TableHead className={headCls}>Native</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {allEntities.map((entity) => {
          const metadata = metadataFor(entity);
          const isSelected = selected === entity;
          const { one, many } = cardinalitySplit(entity);
          return (
            <Fragment key={entity}>
              <TableRow data-state={isSelected ? "selected" : undefined}>
                <TableCell
                  className={cn(cellCls, "sticky left-0 z-10 bg-background")}
                >
                  <button
                    type="button"
                    className="inline-flex min-h-8 items-center gap-1.5 text-left font-mono hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                    aria-expanded={isSelected}
                    aria-controls={`entity-details-${entity}`}
                    onClick={() => onSelect(isSelected ? null : entity)}
                  >
                    <ChevronDown
                      aria-hidden
                      className={cn(
                        "size-3.5 shrink-0 transition-transform",
                        !isSelected && "-rotate-90",
                      )}
                    />
                    <EntityIcon entity={entity} className="size-3.5 shrink-0" />
                    {entity}
                  </button>
                </TableCell>
                <TableCell className={cn(cellCls, mono)}>
                  {emittedCode(entity) ?? dash}
                </TableCell>
                <TableCell className={cn(cellCls, mono)}>
                  {countFor(entity, counts) ?? dash}
                </TableCell>
                <TableCell className={cellCls}>
                  <KernelActionsCell entity={entity} />
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
                  title={mcpTransportLabel(entity)}
                >
                  {metadata.mcpOperations.length}
                </TableCell>
                <TableCell className={cn(cellCls, mono)}>
                  {overridesFor(entity).length}
                </TableCell>
                <TableCell
                  className={cn(cellCls, "max-w-[10rem] truncate")}
                  title={nativeCoverageLabel(entity)}
                >
                  {nativeCoverageLabel(entity)}
                </TableCell>
              </TableRow>
              {isSelected && <OverridesSubRow entity={entity} />}
              {isSelected && <RelationsSubRow entity={entity} />}
            </Fragment>
          );
        })}
      </TableBody>
    </Table>
  );
}

export function EntityManifestGrid({
  selected,
  onSelect,
  active = true,
}: {
  selected: Entity | null;
  onSelect: (entity: Entity | null) => void;
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
