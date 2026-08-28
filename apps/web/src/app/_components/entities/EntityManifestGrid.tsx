import type { Entity } from "@cubby/schemas/entity";
import {
  allEntities,
  entityInspectorMetadata,
  entityManifest,
  entityReferences,
} from "@cubby/schemas/entity-manifest";
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

function acceptedCodes(entity: Entity) {
  const metadata = entityInspectorMetadata[entity];
  return [metadata.shortcodePrefix, metadata.legacyShortcodePrefix]
    .filter((prefix) => prefix !== null)
    .map((prefix) => `${prefix}XXXX`);
}

function printsLabels(entity: Entity) {
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
        accepts <code>{metadata.legacyShortcodePrefix}XXXX</code> inbound
        because physical labels using the shorter prefix already exist.
      </p>
    </div>
  );
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
  return entityInspectorMetadata[entity].mcpOperations.length
    ? "generated kernel command schema"
    : "not exposed";
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

function RelationshipContract({ entity }: { entity: Entity }) {
  const { relationships } = entityManifest[entity];
  if (relationships.length === 0) return dash;
  return relationships.map((relation) => (
    <div
      key={relation.key}
      className="grid gap-1 border-b border-border/60 pb-2 text-xs sm:grid-cols-[9rem_1fr]"
    >
      <code>{relation.key}</code>
      <span>
        → {relation.target} · {relation.deletionPolicy} ·{" "}
        {relation.provenance.kind} · inverse{" "}
        {"inverse" in relation ? "declared" : "external/unconstrained"}
      </span>
    </div>
  ));
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

      {(entity === "product" || entity === "location") && (
        <PrintedLabelContract entity={entity} />
      )}

      <Section title="Identity and storage">
        <ContractRows
          rows={[
            ["Route", route?.detail ?? "No browser detail route"],
            ["Table", descriptor.dbTable ?? dash],
            ["ID brand", descriptor.idBrand ?? dash],
            ["Presentation", metadata.titleField],
            ["Live rows", count ?? "Unavailable"],
          ]}
        />
      </Section>

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
            [
              "Alias direction",
              metadata.legacyShortcodePrefix ? "inbound only" : "none",
            ],
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
          ]}
        />
      </Section>

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
        <div className="space-y-2">
          <RelationshipContract entity={entity} />
        </div>
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
            ["Lifecycle policy", sourceRef(metadata.ports.lifecycle.policy)],
            ["Lifecycle runtime", sourceRef(metadata.ports.lifecycle.runtime)],
            [
              "Relation attach",
              sourceRef(metadata.ports.relationMutation.attach),
            ],
            [
              "Relation detach",
              sourceRef(metadata.ports.relationMutation.detach),
            ],
          ]}
        />
      </Section>

      <Section title="Transports, UI, and coverage">
        <ContractRows
          rows={[
            ["Start", startTransportLabel(entity)],
            ["Extensions", "explicit workflow extensions only"],
            [
              "MCP",
              metadata.mcpOperations.length
                ? metadata.mcpOperations.join(", ")
                : "—",
            ],
            [
              "Routes / pages",
              route ? `${route.list} · ${route.detail}` : "workflow-owned",
            ],
            ["Saved views", <SavedViewChips key="views" entity={entity} />],
            [
              "Contract tiers",
              "generated · unit · PGlite · PostgreSQL · UI · E2E",
            ],
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
      <Section title="Reference graph">
        <EntityReferenceGraph />
      </Section>
    </Stack>
  );
}
