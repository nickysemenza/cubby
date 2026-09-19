import type { Entity } from "@cubby/schemas/entity";
import { generatedEntityEditIntents } from "@cubby/schemas/entity-edit-intents";
import {
  allEntities,
  type EntityDescriptor,
  entityInspectorMetadata,
  entityManifest,
  entityReferences,
  photoCategories,
} from "@cubby/schemas/entity-manifest";
import { generatedEntitySort } from "@cubby/schemas/entity-sort";
import type { EntityPresentation } from "@cubby/schemas/entity-summary";
import { LEGACY_SHORTCODE_PREFIX } from "@cubby/shared";
import { useQuery } from "@tanstack/react-query";
import { Check, Copy, Minus, Stamp } from "lucide-react";
import { type ReactNode, useId } from "react";
import { toast } from "sonner";

import { Stack } from "~/components/layout";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "~/components/ui/collapsible";
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
import { copyText } from "~/lib/clipboard";
import { ENTITY_NATIVE_COVERAGE } from "~/lib/generated/entity-native-coverage.gen";
import { HTTP_RESOURCES } from "~/lib/generated/http-resources.gen";
import { cn } from "~/lib/utils";

import { EntityReferenceGraph } from "./EntityReferenceGraph";

const mono = "font-mono text-xs tabular-nums";
const dash = <span className="text-muted-foreground/40">—</span>;
const contractRow = (label: string, value: ReactNode): [string, ReactNode] => [
  label,
  value,
];

function Bool({ value }: { value: boolean }) {
  return value ? (
    <Check className="size-4 text-positive" aria-label="yes" />
  ) : (
    <Minus className="size-4 text-muted-foreground/40" aria-label="no" />
  );
}

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

function referencesInto(target: Entity): Entity[] {
  return allEntities.filter((entity) =>
    entityReferences(entity).includes(target),
  );
}

function emittedCode(entity: Entity) {
  const prefix = entityInspectorMetadata[entity].shortcodePrefix;
  return prefix ? `${prefix}XXXX` : null;
}

function sourceRef(ref: { module: string; export: string } | null) {
  return ref ? `${ref.module}#${ref.export}` : "not declared";
}

/**
 * `entityManifest[entity]`'s generated literal type omits an `optional()`
 * schema key entirely for an entity that leaves it unset, rather than typing
 * it `| undefined` — so a union-wide read of `countFilter`/
 * `relatednessSignals`/`mcpNames` doesn't type-check against every member.
 * Widen back to the zod-inferred shape, which `parsedEntityManifest` in
 * `entity-manifest.ts` already verifies every entry satisfies.
 */
function extendedManifest(entity: Entity): EntityDescriptor {
  // SAFETY: see doc comment above — `entityManifest[entity]` always
  // satisfies `entityDescriptor`, just not through a type TS can see here.
  return entityManifest[entity] as EntityDescriptor;
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
  return [entityInspectorMetadata[entity].shortcodePrefix, legacyPrefix(entity)]
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

function ContractRows({
  rows,
}: {
  rows: readonly [label: string, value: ReactNode][];
}) {
  return (
    <dl className="divide-y divide-border/60 border-y border-border/60">
      {rows.map(([label, value]) => (
        <div
          key={label}
          className="grid gap-1 py-2 sm:grid-cols-[10rem_minmax(0,1fr)]"
        >
          <dt className="text-xs text-muted-foreground">{label}</dt>
          <dd className="min-w-0 text-sm">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function PrintedLabelContract({ entity }: { entity: "product" | "location" }) {
  const metadata = entityInspectorMetadata[entity];
  return (
    <div className="border-y border-primary/40 bg-primary/[0.04] px-4 py-4">
      <div className="flex items-center gap-2 text-sm font-medium text-primary">
        <Stamp className="size-4" /> Printed-label contract
      </div>
      <p className="mt-1 text-sm">
        Cubby emits <code>{metadata.shortcodePrefix}XXXX</code> and permanently
        accepts <code>{legacyPrefix(entity)}XXXX</code> inbound because physical
        labels using the shorter prefix already exist.
      </p>
    </div>
  );
}

function EntityPrintedLabelContract({ entity }: { entity: Entity }) {
  return printsLabels(entity) ? <PrintedLabelContract entity={entity} /> : null;
}

function countFor(
  entity: Entity,
  counts: EntityInspectorHealth["counts"] | undefined,
) {
  if (!counts) return undefined;
  return entityManifest[entity].countable ? counts[entity] : undefined;
}

function EntityIndex({
  selected,
  onSelect,
}: {
  selected: Entity;
  onSelect: (entity: Entity) => void;
}) {
  return (
    <nav
      aria-label="Entity index"
      className="grid grid-cols-2 border-y sm:grid-cols-3 md:hidden"
    >
      {allEntities.map((entity) => (
        <button
          key={entity}
          type="button"
          aria-current={selected === entity ? "true" : undefined}
          onClick={() => onSelect(entity)}
          className={cn(
            "min-h-11 border-r border-b border-border/60 px-4 py-2 text-left font-mono text-xs",
            selected === entity && "bg-primary text-primary-foreground",
          )}
        >
          {entity}
        </button>
      ))}
    </nav>
  );
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

function ComparisonMatrix({
  selected,
  counts,
  onSelect,
}: {
  selected: Entity;
  counts: EntityInspectorHealth["counts"] | undefined;
  onSelect: (entity: Entity) => void;
}) {
  return (
    <div className="hidden overflow-x-auto border-y md:block">
      <Table className="min-w-[1100px] table-auto">
        <TableHeader>
          <TableRow>
            <TableHead>Entity</TableHead>
            <TableHead>Rows</TableHead>
            <TableHead>Actions</TableHead>
            <TableHead>Search / embed</TableHead>
            <TableHead>MCP</TableHead>
            <TableHead>Lifecycle</TableHead>
            <TableHead>Relations</TableHead>
            <TableHead>Canonical</TableHead>
            <TableHead>Inbound aliases</TableHead>
            <TableHead>Prints labels</TableHead>
            <TableHead>Native</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {allEntities.map((entity) => {
            const metadata = entityInspectorMetadata[entity];
            return (
              <TableRow
                key={entity}
                data-state={selected === entity ? "selected" : undefined}
                className="cursor-pointer"
                onClick={() => onSelect(entity)}
              >
                <TableCell>
                  <span className="font-mono text-xs">{entity}</span>
                </TableCell>
                <TableCell className={mono}>
                  {countFor(entity, counts) ?? "—"}
                </TableCell>
                <TableCell>
                  <Chips items={metadata.kernelActions} />
                </TableCell>
                <TableCell className="whitespace-nowrap">
                  {metadata.searchable ? "lexical · semantic" : "—"}
                </TableCell>
                <TableCell className={mono}>
                  {metadata.mcpOperations.length}
                </TableCell>
                <TableCell className="text-xs whitespace-nowrap">
                  {metadata.lifecycle.delete?.mode ?? "—"}
                  {metadata.lifecycle.merge ? " · merge" : ""}
                </TableCell>
                <TableCell className={mono}>
                  {metadata.references.length}
                </TableCell>
                <TableCell className={mono}>
                  {emittedCode(entity) ?? "—"}
                </TableCell>
                <TableCell>
                  <Chips items={acceptedCodes(entity).slice(1)} />
                </TableCell>
                <TableCell>
                  <Bool value={printsLabels(entity)} />
                </TableCell>
                <TableCell className="text-xs whitespace-nowrap">
                  {nativeCoverageLabel(entity)}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

function physicalCompatibility(entity: Entity) {
  if (printsLabels(entity)) {
    return "Permanent inbound rewrite; Cubby never emits the legacy form.";
  }
  if (entity === "recipe") {
    return "Canonical RCP- only. The removed R- form is intentionally rejected.";
  }
  return "Canonical prefix only.";
}

function physicalPermanence(entity: Entity) {
  return printsLabels(entity)
    ? "permanent — printed labels"
    : "canonical contract only";
}

function schemaOwnershipRows(entity: Entity) {
  const sourceRefs = entityInspectorMetadata[entity].sourceRefs;
  if (!sourceRefs) {
    return [
      contractRow(
        "Schema ownership",
        "Workflow extension; no generic CRUD schema contract",
      ),
    ];
  }
  return Object.entries(sourceRefs).map(([name, ref]) =>
    contractRow(
      name,
      <span key={name} className={mono}>
        {ref} · generated binding
      </span>,
    ),
  );
}

function searchPortLabel(
  searchable: boolean,
  port: Parameters<typeof sourceRef>[0],
  suffix: string,
) {
  return searchable ? `${sourceRef(port)}${suffix}` : "not exposed";
}

function inspectorRoute(entity: Entity) {
  return isBrowserRoutedEntity(entity)
    ? browserEntityDefinition(entity).routes
    : null;
}

function mcpFieldLabel(entity: Entity) {
  const metadata = entityInspectorMetadata[entity];
  return metadata.mcpOwner === "kernel"
    ? "generated kernel command schema"
    : "specialized workflow schema";
}

function mcpTransportLabel(entity: Entity) {
  const metadata = entityInspectorMetadata[entity];
  return `${metadata.mcpOwner}: ${metadata.mcpOperations.join(", ")}`;
}

function routeCoverageLabel(entity: Entity) {
  const route = inspectorRoute(entity);
  return route ? `${route.list} · ${route.detail}` : "workflow-owned";
}

function dependentRefreshLabel(entity: Entity) {
  const metadata = entityInspectorMetadata[entity];
  return metadata.searchable
    ? sourceRef(metadata.ports.search.dependentRefresh)
    : "none";
}

function startTransportLabel(entity: Entity) {
  const metadata = entityInspectorMetadata[entity];
  if (entity === "usda-food" || entity === "cookbook") {
    return "specialized list · detail";
  }
  if (entity === "image") return "dedicated list · detail · writes";
  if (metadata.kernelActions.length === 0) return "—";
  return [
    metadata.kernelActions.includes("get") && "detail",
    metadata.kernelActions.includes("list") && "list/filter",
    metadata.kernelActions.some((action) =>
      ["create", "update", "delete", "merge"].includes(action),
    ) && "generic writes",
  ]
    .filter(Boolean)
    .join(" · ");
}

/** `singular / plural`, falling back to `—` for a name half the manifest leaves unset. */
function mcpNamesLabel(entity: Entity) {
  const names = extendedManifest(entity).mcpNames;
  if (!names) return dash;
  return `${names.singular ?? "—"} / ${names.plural ?? "—"}`;
}

/** The browser route's base path, or a dash for an entity with no browser route. */
function basePathFor(entity: Entity) {
  return isBrowserRoutedEntity(entity) ? (
    <code key="basePath">{browserEntityDefinition(entity).basePath}</code>
  ) : (
    dash
  );
}

/** The declared `countFilter` enum value, or a dash when the entity leaves it unset. */
function countFilterCell(entity: Entity) {
  const countFilter = extendedManifest(entity).countFilter;
  return countFilter ? <code key="countFilter">{countFilter}</code> : dash;
}

/** Each declared relatedness signal's `kind: label`, or a dash when none are declared. */
function relatednessSignalsCell(entity: Entity) {
  const signals = extendedManifest(entity).relatednessSignals;
  if (!signals?.length) return dash;
  return (
    <Chips
      key="relatedness"
      items={signals.map((signal) => `${signal.kind}: ${signal.label}`)}
    />
  );
}

function RelationshipContract({ entity }: { entity: Entity }) {
  const { relationships } = entityManifest[entity];
  if (relationships.length === 0) return dash;
  return relationships.map((relation) => (
    <div
      key={relation.key}
      className="grid gap-1 border-b border-border/60 pb-2 text-xs sm:grid-cols-[9rem_1fr]"
    >
      <code>{relation.key}</code>
      <Stack gap="tight">
        <span>
          → {relation.target} · {relation.cardinality} ·{" "}
          {relation.provenance.kind} · inverse{" "}
          {"inverse" in relation ? "declared" : "external"}
        </span>
        <div className="text-muted-foreground">
          sources: {relation.sourceKey}
          {relation.sources.map((source) => `, ${source.key}`).join("")}
          {"mutation" in relation
            ? ` · mutable via ${relation.mutation.source} (${relation.mutation.audiences.join(", ")})`
            : ""}
        </div>
      </Stack>
    </div>
  ));
}

function PresentationSection({ entity }: { entity: Entity }) {
  const metadata = entityInspectorMetadata[entity];
  // The `as const` roster types each entity's block exactly; widen once so an
  // optional `actionLabel` reads the same for every entity.
  const emptyState: EntityPresentation["emptyState"] = metadata.emptyState;
  const images =
    metadata.imageStorage === false
      ? dash
      : metadata.imageStorage === "gallery"
        ? "gallery (ordered join table)"
        : "cover (single coverImageId)";
  return (
    <Section title="Presentation">
      <ContractRows
        rows={[
          ["Title field", <code key="title">{metadata.titleField}</code>],
          ["Domain", metadata.domain ?? "none (no wayfinding line)"],
          ["Description", metadata.description],
          [
            "Icons",
            <span key="icons" className="inline-flex items-center gap-2">
              <EntityIcon entity={entity} className="size-4" />
              <code>{metadata.icons.lucide}</code>
              <span className="text-muted-foreground/60">web ·</span>
              <code>{metadata.icons.sfSymbol}</code>
              <span className="text-muted-foreground/60">native ·</span>
              <span aria-hidden="true">{metadata.icons.emoji}</span>
              <span className="text-muted-foreground/60">emoji</span>
            </span>,
          ],
          ["Empty state", emptyState.title],
          ["Empty copy", emptyState.description],
          ["Empty action", emptyState.actionLabel ?? dash],
          ["Images", images],
        ]}
      />
    </Section>
  );
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
 * The native shell draws four domain lines; the declaration vocabulary has
 * five. Mirrors `AppDomain.init(_:)` in
 * `apps/apple/App/Shared/Theme/PorcelainTokens.swift`: pantry files under
 * House, and an entity on no line (image) files under House too.
 */
const nativeDomain = (domain: EntityPresentation["domain"]): string =>
  domain === null || domain === "pantry" ? "house (fallback)" : domain;

/**
 * What the native app can do with this entity, from
 * `entity-native-coverage.gen.ts` (emitted by the same script that writes
 * `EntityOperations.swift`). "HTTP exposes" is the web API's resource verbs
 * — what Swift's `httpActions` mirrors; "Native client" is the set the
 * filtered OpenAPI client carries (every list/get/create/update/timeline
 * verb; delete stays off it).
 */
function NativeSection({ entity }: { entity: Entity }) {
  const metadata = entityInspectorMetadata[entity];
  const coverage = ENTITY_NATIVE_COVERAGE[entity];
  // SAFETY: `HTTP_RESOURCES` is `satisfies Partial<Record<Entity, …>>`; an
  // entity with no HTTP resource simply has no entry.
  const resource = (
    HTTP_RESOURCES as Partial<Record<Entity, { verbs: readonly string[] }>>
  )[entity];
  return (
    <Section title="Native app">
      <ContractRows
        rows={[
          ["Domain (app)", nativeDomain(metadata.domain)],
          ["Countable", <Bool key="countable" value={metadata.countable} />],
          ["HTTP exposes", <Chips key="verbs" items={resource?.verbs ?? []} />],
          [
            "Native client",
            <Chips key="native" items={coverage.httpActions} />,
          ],
          [
            "Image attach / reorder",
            <span key="images" className="inline-flex items-center gap-2">
              <Bool value={coverage.imageAttach} />
              <span className="text-muted-foreground/60">·</span>
              <Bool value={coverage.imageOrder} />
            </span>,
          ],
          ["RPC operations", <Chips key="rpc" items={coverage.rpcIds} />],
        ]}
      />
    </Section>
  );
}

type SortRoster =
  (typeof generatedEntitySort)[keyof typeof generatedEntitySort];

function sortRosterFor(entity: Entity): SortRoster | undefined {
  // SAFETY: `generatedEntitySort` is `satisfies Partial<Record<Entity, …>>`;
  // an entity with no declared list-sort roster simply has no entry.
  return (generatedEntitySort as Partial<Record<Entity, SortRoster>>)[entity];
}

/**
 * The `model.sort` roster from `entity-sort.gen.ts`. An empty `groupable`
 * means every sortable field is groupable (see docs/entities.md); an entity
 * with no roster at all (only `usda-food` today) gets a single explanatory
 * row rather than an empty section.
 */
function SortingSection({ entity }: { entity: Entity }) {
  const roster = sortRosterFor(entity);
  return (
    <Section title="Sorting">
      <ContractRows
        rows={
          roster
            ? [
                ["Default", <code key="default">{roster.default}</code>],
                ["Fields", <Chips key="fields" items={roster.fields} />],
                [
                  "Computed",
                  roster.computed.length ? (
                    <Chips key="computed" items={roster.computed} />
                  ) : (
                    dash
                  ),
                ],
                [
                  "Groupable",
                  roster.groupable.length ? (
                    <Chips key="groupable" items={roster.groupable} />
                  ) : (
                    "all sortable fields"
                  ),
                ],
              ]
            : [["Declared", "none (hand roster)"]]
        }
      />
    </Section>
  );
}

type EditIntents =
  (typeof generatedEntityEditIntents)[keyof typeof generatedEntityEditIntents];

function editIntentsFor(entity: Entity): EditIntents | undefined {
  // SAFETY: `generatedEntityEditIntents` is `satisfies Partial<Record<Entity, …>>`;
  // an entity with no browser editor declaration simply has no entry.
  return (generatedEntityEditIntents as Partial<Record<Entity, EditIntents>>)[
    entity
  ];
}

/**
 * The editor's named field fragments (`fields`) and the ordered intent names
 * `create`/`update` accept, from `entity-edit-intents.gen.ts`. An entity
 * absent from the map (`cookbook`, `image`, `usda-food` today) has no
 * browser-editable form at all.
 */
function EditIntentsSection({ entity }: { entity: Entity }) {
  const intents = editIntentsFor(entity);
  if (!intents) {
    return (
      <Section title="Edit intents">
        <ContractRows rows={[["Editable", "not editable in the browser"]]} />
      </Section>
    );
  }
  return (
    <Section title="Edit intents">
      <ContractRows
        rows={[
          ["Create intents", <Chips key="create" items={intents.create} />],
          ["Update intents", <Chips key="update" items={intents.update} />],
          ...Object.entries(intents.fields).map(([name, fields]) =>
            contractRow(name, <Chips key={name} items={fields} />),
          ),
        ]}
      />
    </Section>
  );
}

export function EntityInspector({
  entity,
  count,
  health,
}: {
  entity: Entity;
  count?: number;
  health?: EntityInspectorHealth["search"][keyof EntityInspectorHealth["search"]];
}) {
  const descriptor = entityManifest[entity];
  const metadata = entityInspectorMetadata[entity];
  const headingId = useId();
  const route = inspectorRoute(entity);
  const json = JSON.stringify(
    {
      entity,
      ...metadata,
      storage: { table: descriptor.dbTable, idBrand: descriptor.idBrand },
      acceptedInbound: acceptedCodes(entity),
      emits: emittedCode(entity),
      printsLabels: printsLabels(entity),
      relationships: descriptor.relationships,
    },
    null,
    2,
  );

  return (
    <article className="space-y-6" aria-labelledby={headingId}>
      <header className="border-l border-primary pl-3">
        <div className="flex flex-wrap items-baseline gap-2">
          <h2 id={headingId} className="font-heading text-2xl">
            {metadata.singular}
          </h2>
          <Badge variant="outline" className="font-mono text-2xs">
            {entity}
          </Badge>
          <Badge variant="outline" className="text-2xs">
            {metadata.sourceRefs ? "explicit port" : "workflow extension"}
          </Badge>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          Compiled from the literal specification; SQL, transactions, and
          workflow behavior remain behind explicit runtime ports.
        </p>
      </header>

      <EntityPrintedLabelContract entity={entity} />

      <Section title="Identity and storage">
        <ContractRows
          rows={[
            ["Route", route?.detail ?? "No browser detail route"],
            ["Base path", basePathFor(entity)],
            ["Table", descriptor.dbTable ?? dash],
            ["ID brand", descriptor.idBrand ?? dash],
            ["Live rows", count ?? "Unavailable"],
          ]}
        />
      </Section>

      <PresentationSection entity={entity} />

      <Section title="Physical identifiers">
        <ContractRows
          rows={[
            [
              "Prints labels",
              <Bool key="print" value={printsLabels(entity)} />,
            ],
            [
              "Canonical emitted",
              <code key="emit">{emittedCode(entity) ?? "—"}</code>,
            ],
            [
              "Accepted inbound",
              <Chips key="accept" items={acceptedCodes(entity)} />,
            ],
            ["Compatibility", physicalCompatibility(entity)],
            ["Alias direction", legacyPrefix(entity) ? "inbound only" : "none"],
            ["Permanence", physicalPermanence(entity)],
          ]}
        />
      </Section>

      <Section title="Schemas and ports">
        <ContractRows
          rows={[
            ...schemaOwnershipRows(entity),
            ["Repository adapter", sourceRef(metadata.ports.repository)],
            ["Reference label", sourceRef(metadata.ports.references.label)],
            [
              "Reference resolver",
              sourceRef(metadata.ports.references.resolver),
            ],
          ]}
        />
      </Section>

      <Section title="Kernel actions and filters">
        <Chips items={metadata.kernelActions} />
        <p className="my-2 text-xs text-muted-foreground">
          Missing detail records return null; routes translate that to not-found
          UI.
        </p>
        <ContractRows
          rows={[
            [
              "Descriptor ownership",
              `${metadata.filterDescriptors.length} literal descriptors · generated bindings`,
            ],
            [
              "Descriptor kinds",
              <Chips
                key="kinds"
                items={[
                  ...new Set(
                    metadata.filterDescriptors.map((filter) => filter.kind),
                  ),
                ]}
              />,
            ],
            [
              "URL codec keys",
              <Chips key="url" items={metadata.filterUrlKeys} />,
            ],
            ["Validation", "generated Zod field bindings"],
            ["Controls and codecs", sourceRef(metadata.ports.filters)],
            ["SQL predicates", "explicit repository predicates"],
            ["Option loaders", "generated static/deferred bindings"],
            ["MCP fields", mcpFieldLabel(entity)],
            ["Count filter", countFilterCell(entity)],
          ]}
        />
      </Section>

      <SortingSection entity={entity} />

      <EditIntentsSection entity={entity} />

      <Section title="Search">
        <ContractRows
          rows={[
            [
              "Lexical projection",
              searchPortLabel(
                metadata.searchable,
                metadata.ports.search.projection,
                "",
              ),
            ],
            [
              "Semantic text",
              searchPortLabel(
                metadata.searchable,
                metadata.ports.search.semanticText,
                " · pgvector",
              ),
            ],
            ["Dependent refresh", dependentRefreshLabel(entity)],
          ]}
        />
      </Section>

      <Section title="Relations and lifecycle">
        <Stack gap="sm">
          <RelationshipContract entity={entity} />
        </Stack>
        <div className="mt-4">
          <Chips
            items={[
              `delete:${metadata.lifecycle.delete?.mode ?? "none"}`,
              `merge:${metadata.lifecycle.merge}`,
            ]}
          />
        </div>
        <ContractRows
          rows={[
            ["Delete owner", metadata.operationOwners.delete ?? "none"],
            ["Merge owner", metadata.operationOwners.merge ?? "none"],
            ["Relatedness signals", relatednessSignalsCell(entity)],
          ]}
        />
      </Section>

      <Section title="Transports, UI, and coverage">
        <ContractRows
          rows={[
            ["Start", startTransportLabel(entity)],
            ["Extensions", "explicit workflow extensions only"],
            ["MCP", mcpTransportLabel(entity)],
            ["MCP names", mcpNamesLabel(entity)],
            ["Routes / pages", routeCoverageLabel(entity)],
            ["Saved views", <SavedViewChips key="views" entity={entity} />],
            ["Contract tiers", "generated · unit · PostgreSQL · UI · E2E"],
            [
              "Live health",
              `rows ${count ?? "unavailable"} · documents ${health?.documents ?? "—"} · embeddings ${health?.embeddings ?? "—"}`,
            ],
            [
              "Referenced by",
              <Chips key="inbound" items={referencesInto(entity)} />,
            ],
          ]}
        />
      </Section>

      <NativeSection entity={entity} />

      <Collapsible>
        <div className="flex items-center justify-between border-y py-2">
          <CollapsibleTrigger className="font-mono text-xs tracking-wider uppercase">
            Compiled contract JSON
          </CollapsibleTrigger>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() =>
              void copyText(json).then((ok) =>
                ok
                  ? toast.success("Contract copied")
                  : toast.error("Copy failed"),
              )
            }
          >
            <Copy className="size-4" /> Copy
          </Button>
        </div>
        <CollapsibleContent>
          <pre className="max-h-[32rem] overflow-auto bg-muted/35 p-4 text-xs">
            {json}
          </pre>
        </CollapsibleContent>
      </Collapsible>
    </article>
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
    (entity) => entityInspectorMetadata[entity].kernelActions.length > 0,
  ).length;
  const searchCount = allEntities.filter(
    (entity) => entityInspectorMetadata[entity].searchable,
  ).length;
  const mcpCount = allEntities.filter(
    (entity) => entityInspectorMetadata[entity].mcpOperations.length > 0,
  ).length;
  const explicitPortCount = allEntities.filter(
    (entity) => entityInspectorMetadata[entity].ports.repository !== null,
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

      <EntityIndex selected={selected} onSelect={onSelect} />
      <ComparisonMatrix
        selected={selected}
        counts={counts}
        onSelect={onSelect}
      />
      <EntityInspector
        entity={selected}
        count={countFor(selected, counts)}
        health={health?.search[selected]}
      />
      <PhotoCategoriesSection />
      <Section title="Reference graph">
        <EntityReferenceGraph />
      </Section>
    </Stack>
  );
}
