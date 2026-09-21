import type { Entity } from "@cubby/schemas/entity";
import { isAuditableEntity } from "@cubby/schemas/entity-manifest";
import { type ReactNode, useCallback, useState } from "react";

import {
  EntityActionButtons,
  type EntityActionRow,
} from "~/app/_components/actions/entity-actions";
import { AuditLogList } from "~/app/_components/audit-log/audit-log-list";
import {
  EntityIcon,
  entityLabel,
  isBrowserRoutedEntity,
} from "~/entities/entities";

import { EntityPreviewContent } from "./EntityPreviewContent";
import { EntityInspectorFrame, type InspectorTab } from "./inspector-frame";
import {
  type HoverPreviewEntity,
  hoverPreviewEntities,
} from "./preview/preview-entities";
import {
  EntityRelations,
  supportsEntityGraph,
} from "./relationships/entity-relations";
import { EntityRelationshipPreview } from "./relationships/entity-relationship-preview";

type EntityWorkbenchInspectorProps = {
  entity: Entity;
  id: string;
  onClose?: () => void;
  overviewSupplement?: ReactNode;
};

const COMPACT_OVERVIEW_ENTITIES: ReadonlySet<Entity> = new Set(
  hoverPreviewEntities,
);

const supportsCompactOverview = (
  entity: Entity,
): entity is HoverPreviewEntity => COMPACT_OVERVIEW_ENTITIES.has(entity);

function UnsupportedOverview({ entity, id }: { entity: Entity; id: string }) {
  const label = entityLabel(entity);

  return (
    <div className="space-y-2 px-3 py-3">
      <div className="flex items-center gap-2">
        <EntityIcon entity={entity} colored className="size-3.5" />
        <p className="text-xs font-medium text-foreground">{label}</p>
      </div>
      <p className="font-mono text-xs text-muted-foreground">{id}</p>
      <p className="text-xs text-muted-foreground">
        {isBrowserRoutedEntity(entity)
          ? "Open the full record to inspect its details."
          : "Use Relations or Activity to inspect linked records."}
      </p>
    </div>
  );
}

/**
 * Compact inspector shared by canonical sibling lists. Product keeps its
 * purpose-built workbench inspector; this surface never mounts a full detail
 * page inside the table dock.
 */
export function EntityWorkbenchInspector({
  entity,
  id,
  onClose,
  overviewSupplement,
}: EntityWorkbenchInspectorProps) {
  return (
    <EntityWorkbenchInspectorContent
      key={`${entity}:${id}`}
      entity={entity}
      id={id}
      onClose={onClose}
      overviewSupplement={overviewSupplement}
    />
  );
}

function EntityWorkbenchInspectorContent({
  entity,
  id,
  onClose,
  overviewSupplement,
}: EntityWorkbenchInspectorProps) {
  const [activeTab, setActiveTab] = useState<InspectorTab>("overview");
  const [resolvedName, setResolvedName] = useState<string | undefined>();
  const [resolvedRecord, setResolvedRecord] = useState<
    EntityActionRow | undefined
  >();
  // Product has a page-owned relationship contract and a specialist inspector.
  // Do not add the generic graph beside that richer route.
  const hasRelations = entity !== "product" && supportsEntityGraph(entity);
  const hasActivity = isAuditableEntity(entity);
  const handleNameResolved = useCallback((name: string) => {
    setResolvedName((current) => (current === name ? current : name));
  }, []);
  const handleRecordResolved = useCallback(
    (record: EntityActionRow | undefined) => {
      setResolvedRecord((current) => (current === record ? current : record));
    },
    [],
  );

  return (
    <EntityInspectorFrame
      entity={entity}
      id={id}
      name={resolvedName}
      activeTab={activeTab}
      onTabChange={setActiveTab}
      onClose={onClose}
      overview={
        <div>
          {overviewSupplement}
          {supportsCompactOverview(entity) ? (
            <div className="px-3 py-3">
              <EntityPreviewContent
                entity={entity}
                id={id}
                showOpenAction={false}
                showIdentityHeader={false}
                onNameResolved={handleNameResolved}
                onRecordResolved={handleRecordResolved}
              />
            </div>
          ) : (
            <UnsupportedOverview entity={entity} id={id} />
          )}
          {hasRelations ? (
            <EntityRelationshipPreview
              entity={entity}
              sourceId={id}
              name={resolvedName}
              onViewAll={() => setActiveTab("relations")}
            />
          ) : null}
          {entity !== "product" && resolvedRecord ? (
            <div className="flex flex-wrap gap-2 px-3 pb-3">
              <EntityActionButtons
                entity={entity}
                record={resolvedRecord}
                surface="inspector"
              />
            </div>
          ) : null}
        </div>
      }
      relations={
        hasRelations ? (
          <div className="px-3 py-3">
            <EntityRelations entity={entity} sourceId={id} />
          </div>
        ) : undefined
      }
      activity={
        hasActivity ? (
          <div className="px-3 py-3">
            <AuditLogList
              entityType={entity}
              entityId={id}
              showEntityLink={false}
            />
          </div>
        ) : undefined
      }
    />
  );
}
