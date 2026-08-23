import type { Entity } from "@cubby/schemas/entity";
import type {
  IntegrityCatalog,
  LifecycleOperation,
  OperationEffect,
  PhysicalEdge,
  ReferentialLivenessViolation,
  RelationshipProvenance,
} from "@cubby/schemas/entity-integrity";
import { referentialLivenessViolationSchema } from "@cubby/schemas/entity-integrity";
import { useQuery } from "@tanstack/react-query";
import { HeartPulse, Trash2, Waypoints } from "lucide-react";
import type { ReactNode } from "react";
import { useMemo, useState } from "react";
import { SimpleLoading } from "~/components/feedback/loading-skeletons";
import { Grid, Row, Stack } from "~/components/layout";
import { Badge, type BadgeVariant } from "~/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";
import { Eyebrow } from "~/components/ui/eyebrow";
import { StatTile } from "~/components/ui/stat-tile";
import { ViewSwitcher } from "~/components/ui/view-switcher";
import { entities, isBrowserRoutedEntity } from "~/entities/entities";
import { useTRPC } from "~/integrations/trpc/react";
import {
  type EntityGraphLens,
  EntityReferenceGraph,
} from "./EntityReferenceGraph";

type EntityRow = IntegrityCatalog["entities"][number];
type EntityRelationship = EntityRow["relationships"][number];

const LENS_OPTIONS: {
  value: EntityGraphLens;
  label: string;
  icon: typeof Waypoints;
}[] = [
  { value: "logical", label: "Logical", icon: Waypoints },
  { value: "lifecycle", label: "Lifecycle", icon: Trash2 },
  { value: "health", label: "Health", icon: HeartPulse },
];

const REFERENTIAL_LIVENESS_INPUT = {
  key: "referentialLivenessViolations",
} as const;
const EMPTY_REFERENTIAL_LIVENESS_VIOLATIONS: ReferentialLivenessViolation[] =
  [];
const REFERENTIAL_LIVENESS_STALE_TIME = 60_000;

/** Raw `effect` slug → the badge tone that reads correctly for it. */
const EFFECT_VARIANT: Record<OperationEffect, BadgeVariant> = {
  block: "destructive",
  "soft-delete": "warning",
  "hard-delete": "destructive",
  detach: "outline",
  repoint: "default",
  "move-dedupe": "plum",
  preserve: "positive",
};

/**
 * `/entities?tab=integrity` — the static architecture surface (relationships,
 * physical FK edges, lifecycle dispositions) from `entityIntegrity.catalog`,
 * cross-referenced with the focused referential-liveness Problem query. This
 * must not load the full five-lane Problems dashboard just to render one tab.
 */
export function EntityIntegrityTab() {
  const api = useTRPC();
  const { data: catalog, isLoading: catalogLoading } = useQuery(
    api.entityIntegrity.catalog.queryOptions(),
  );
  const { data: violations = EMPTY_REFERENTIAL_LIVENESS_VIOLATIONS } = useQuery(
    {
      ...api.problems.getByType.queryOptions(REFERENTIAL_LIVENESS_INPUT),
      staleTime: REFERENTIAL_LIVENESS_STALE_TIME,
      select: (result) =>
        referentialLivenessViolationSchema.array().parse(result.items),
    },
  );

  const [selected, setSelected] = useState<Entity | null>(null);
  const [lens, setLens] = useState<EntityGraphLens>("logical");

  const unhealthyEntities = useMemo(
    () => new Set(violations.map((v) => v.targetEntity)),
    [violations],
  );

  if (catalogLoading || !catalog) {
    return <SimpleLoading text="Loading the integrity catalog..." />;
  }

  const selectedRow = selected
    ? catalog.entities.find((e) => e.entity === selected)
    : undefined;
  const selectedOps = selected
    ? catalog.operations.filter((o) => o.entity === selected)
    : [];
  const selectedViolations = selected
    ? violations.filter((v) => v.targetEntity === selected)
    : [];

  return (
    <Stack gap="lg">
      <Grid cols="summary">
        <StatTile label="Relationships">
          {catalog.coverage.relationships}
        </StatTile>
        <StatTile label="Physical edges">
          {catalog.coverage.incomingEdges}
        </StatTile>
        <StatTile label="Audited edges">
          {catalog.coverage.auditedEdges}
        </StatTile>
        <StatTile label="Exempt edges">{catalog.coverage.exemptEdges}</StatTile>
        <StatTile label="Operations">{catalog.coverage.operations}</StatTile>
        <StatTile label="Live violations">
          <span
            className={violations.length > 0 ? "text-destructive" : undefined}
          >
            {violations.length}
          </span>
        </StatTile>
      </Grid>

      <Row justify="between" align="center" wrap gap="md">
        <p className="text-muted-foreground text-sm">
          One node per entity — click a node (or a chip below) to inspect its
          relationships, incoming edges, and lifecycle dispositions.
        </p>
        <ViewSwitcher<EntityGraphLens>
          ariaLabel="Graph lens"
          value={lens}
          onValueChange={setLens}
          options={LENS_OPTIONS}
        />
      </Row>

      <Grid cols="pair">
        <EntityReferenceGraph
          selected={selected}
          onSelect={setSelected}
          lens={lens}
          unhealthyEntities={unhealthyEntities}
        />
        <EntityDetailPanel
          entity={selected}
          row={selectedRow}
          operations={selectedOps}
          violations={selectedViolations}
          onSelect={setSelected}
        />
      </Grid>
    </Stack>
  );
}

/**
 * A dense hairline row — the repeated unit of the detail panel's lists.
 *
 * The sub-scale vertical padding lives here, once, instead of a density-escape
 * comment repeated on every list that needs it. See the Spacing note in
 * apps/web/CLAUDE.md: encapsulate density in a component rather than scattering
 * the escape hatch.
 */
function HairlineRow({ children }: { children: ReactNode }) {
  return (
    <div className="border-[var(--border)] border-b py-1 last:border-b-0">
      {children}
    </div>
  );
}

const entityLabel = (entity: Entity) => {
  if (isBrowserRoutedEntity(entity)) return entities[entity].label;
  const words = entity.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/-/g, " ");
  return words[0]?.toUpperCase() + words.slice(1);
};

/** One step of an FK path (column plus direction) — a dense inline token. */
function PathStepChip({ children }: { children: ReactNode }) {
  return (
    <span className="border border-[var(--border)] px-1 py-0 font-mono text-2xs">
      {children}
    </span>
  );
}

function EntityChip({
  entity,
  onClick,
}: {
  entity: Entity;
  onClick: () => void;
}) {
  const def = isBrowserRoutedEntity(entity) ? entities[entity] : null;
  const Icon = def?.lucideIcon ?? Waypoints;
  const label = entityLabel(entity);
  return (
    <Badge
      variant="outline"
      className="font-sans normal-case tracking-normal"
      render={<button type="button" onClick={onClick} />}
    >
      <Icon className="size-3" />
      {label}
    </Badge>
  );
}

function RelationshipProvenanceView({
  provenance,
}: {
  provenance: RelationshipProvenance;
}) {
  if (provenance.kind === "local-path") {
    return (
      <Row gap="xs" wrap align="center">
        {provenance.steps.map((step, i) => (
          <Row key={step.edge} gap="xs" align="center">
            {i > 0 && <span className="text-muted-foreground">→</span>}
            <PathStepChip>
              {step.edge}
              <span className="text-muted-foreground"> ({step.direction})</span>
            </PathStepChip>
          </Row>
        ))}
      </Row>
    );
  }
  if (provenance.kind === "unconstrained") {
    return (
      <Row gap="xs" align="center" wrap>
        <Badge variant="outline">no FK</Badge>
        <span className="font-mono text-2xs text-muted-foreground">
          {provenance.edge}
        </span>
      </Row>
    );
  }
  return (
    <Row gap="xs" align="center" wrap>
      <Badge variant="outline">external · {provenance.system}</Badge>
      {provenance.sourceColumns.map((col) => (
        <span key={col} className="font-mono text-2xs text-muted-foreground">
          {col}
        </span>
      ))}
    </Row>
  );
}

function RelationshipRow({
  relationship,
  onSelect,
}: {
  relationship: EntityRelationship;
  onSelect: (entity: Entity) => void;
}) {
  return (
    <div className="border-[var(--border)] border-b py-2 last:border-b-0">
      <Row justify="between" align="center" gap="sm" wrap>
        <span className="font-medium text-xs">{relationship.label}</span>
        <EntityChip
          entity={relationship.target}
          onClick={() => onSelect(relationship.target)}
        />
      </Row>
      <div className="mt-1">
        <RelationshipProvenanceView provenance={relationship.provenance} />
      </div>
    </div>
  );
}

function IncomingEdgeRow({ edge }: { edge: PhysicalEdge }) {
  const exempt = edge.semantics.liveness.kind === "allow-target-deleted";
  return (
    <HairlineRow>
      <Row gap="xs" align="center" wrap>
        <span className="font-mono text-2xs">
          {edge.sourceTable}.{edge.sourceColumn}
        </span>
        <Badge variant="secondary">{edge.semantics.role}</Badge>
        {!edge.constrained && <Badge variant="outline">unconstrained</Badge>}
        {exempt && <Badge variant="warning">exempt</Badge>}
      </Row>
      <p className="text-muted-foreground text-xs">
        {edge.semantics.description}
      </p>
      {exempt && edge.semantics.liveness.kind === "allow-target-deleted" && (
        <p className="text-2xs text-muted-foreground">
          {edge.semantics.liveness.reason}
        </p>
      )}
    </HairlineRow>
  );
}

function OperationBlock({ operation }: { operation: LifecycleOperation }) {
  return (
    <Stack gap="sm">
      <Eyebrow>{operation.operation}</Eyebrow>
      <Stack gap="tight">
        {operation.dispositions.map((d) => (
          <HairlineRow key={d.edgeKey}>
            <Row justify="between" align="start" gap="sm" wrap>
              <span className="font-mono text-2xs">{d.edgeKey}</span>
              <Badge variant={EFFECT_VARIANT[d.disposition.effect]}>
                {d.disposition.effect}
              </Badge>
            </Row>
            <p className="text-xs">{d.disposition.description}</p>
            {/* Raw disposition slug, secondary to the human description above. */}
            <p className="font-mono text-2xs text-muted-foreground">
              {d.disposition.code}
            </p>
          </HairlineRow>
        ))}
      </Stack>
    </Stack>
  );
}

function ViolationRow({
  violation,
}: {
  violation: ReferentialLivenessViolation;
}) {
  return (
    <HairlineRow>
      <Row gap="xs" align="center" wrap>
        <Badge variant="destructive">{violation.role}</Badge>
        <span className="font-mono text-2xs">
          {violation.sourceTable} → {violation.edgeKey}
        </span>
      </Row>
      <p className="text-xs">{violation.description}</p>
    </HairlineRow>
  );
}

function EntityDetailPanel({
  entity,
  row,
  operations,
  violations,
  onSelect,
}: {
  entity: Entity | null;
  row: EntityRow | undefined;
  operations: LifecycleOperation[];
  violations: ReferentialLivenessViolation[];
  onSelect: (entity: Entity) => void;
}) {
  if (!entity || !row) {
    return (
      <Card className="flex h-[420px] items-center justify-center">
        <p className="text-muted-foreground text-sm">
          Select an entity in the graph to inspect it.
        </p>
      </Card>
    );
  }

  const def = isBrowserRoutedEntity(entity) ? entities[entity] : null;
  const Icon = def?.lucideIcon ?? Waypoints;
  const label = entityLabel(entity);

  return (
    <Card className="h-[420px] overflow-y-auto">
      <CardHeader>
        <CardTitle icon={Icon}>{label}</CardTitle>
        <CardDescription>
          {row.dbTable ? (
            <span className="font-mono">{row.dbTable}</span>
          ) : (
            "No local table"
          )}
          {row.lifecycle.delete
            ? ` · ${row.lifecycle.delete.mode} delete${row.lifecycle.delete.bulk ? " · bulk" : " · single"}`
            : " · not deletable"}
          {row.lifecycle.merge ? " · mergeable" : ""}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Stack gap="lg">
          {violations.length > 0 && (
            <Stack gap="sm">
              <Eyebrow>Live findings ({violations.length})</Eyebrow>
              <Stack gap="tight">
                {violations.map((v) => (
                  <ViolationRow
                    key={`${v.edgeKey}-${v.sourceId}`}
                    violation={v}
                  />
                ))}
              </Stack>
            </Stack>
          )}

          <Stack gap="sm">
            <Eyebrow>Relationships ({row.relationships.length})</Eyebrow>
            {row.relationships.length === 0 ? (
              <p className="text-muted-foreground text-xs">
                No outgoing relationships.
              </p>
            ) : (
              <Stack gap="tight">
                {row.relationships.map((rel) => (
                  <RelationshipRow
                    key={rel.key}
                    relationship={rel}
                    onSelect={onSelect}
                  />
                ))}
              </Stack>
            )}
          </Stack>

          <Stack gap="sm">
            <Eyebrow>Incoming edges ({row.incomingEdges.length})</Eyebrow>
            {row.incomingEdges.length === 0 ? (
              <p className="text-muted-foreground text-xs">
                Nothing points at this entity.
              </p>
            ) : (
              <Stack gap="tight">
                {row.incomingEdges.map((edge) => (
                  <IncomingEdgeRow key={edge.edgeKey} edge={edge} />
                ))}
              </Stack>
            )}
          </Stack>

          <Stack gap="sm">
            <Eyebrow>Lifecycle operations</Eyebrow>
            {operations.length === 0 ? (
              <p className="text-muted-foreground text-xs">
                No delete or merge operation declared.
              </p>
            ) : (
              <Stack gap="md">
                {operations.map((op) => (
                  <OperationBlock key={op.operation} operation={op} />
                ))}
              </Stack>
            )}
          </Stack>
        </Stack>
      </CardContent>
    </Card>
  );
}
