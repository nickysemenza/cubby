import type { Entity } from "@cubby/schemas/entity";
import { isAuditableEntity } from "@cubby/schemas/entity-manifest";
import { imageUrlSummary } from "@cubby/schemas/image-summary";
import { type ReactNode, useCallback, useState } from "react";
import { z } from "zod";

import {
  EntityActionButtons,
  type EntityActionRow,
} from "~/entity/actions/entity-actions";
import { EntityCover } from "~/entity/components/entity-cover";
import {
  detailEntities,
  type DetailEntity,
} from "~/entity/generated/entity-details.gen";
import { AuditLogList } from "~/features/audit-log/audit-log-list";

import { EntityPreviewContent } from "../components/EntityPreviewContent";
import {
  EntityRelations,
  supportsEntityGraph,
} from "../relationships/entity-relations";
import { EntityRelationshipPreview } from "../relationships/entity-relationship-preview";
import { EntityInspectorFrame, type InspectorTab } from "./inspector-frame";
import { InspectorRecord } from "./inspector-record";

type EntityWorkbenchInspectorProps = {
  entity: Entity;
  id: string;
  onClose?: () => void;
  overviewSupplement?: ReactNode;
};

const recordEntities = new Set<Entity>(detailEntities);
const isDetailEntity = (entity: Entity): entity is DetailEntity =>
  recordEntities.has(entity);
const recordMedia = z.looseObject({
  displayImages: z.array(imageUrlSummary.extend({ id: z.string() })).optional(),
});

/** The inspector shares record fields and mutations without mounting the full route. */
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
  const hasRelations = supportsEntityGraph(entity);
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
      leading={
        <EntityCover
          entity={entity}
          images={
            recordMedia.safeParse(resolvedRecord).data?.displayImages ?? []
          }
          size={40}
          alt={resolvedName ?? ""}
          preview
        />
      }
      activeTab={activeTab}
      onTabChange={setActiveTab}
      onClose={onClose}
      overview={
        <div>
          {overviewSupplement}
          <div className="px-3 py-3">
            {isDetailEntity(entity) ? (
              <InspectorRecord
                entity={entity}
                id={id}
                onNameResolved={handleNameResolved}
                onRecordResolved={handleRecordResolved}
              />
            ) : entity === "usda-food" ? (
              <EntityPreviewContent
                entity={entity}
                id={id}
                showOpenAction={false}
                showIdentityHeader={false}
                onNameResolved={handleNameResolved}
                onRecordResolved={handleRecordResolved}
              />
            ) : null}
          </div>
          {hasRelations ? (
            <EntityRelationshipPreview
              entity={entity}
              sourceId={id}
              name={resolvedName}
              onViewAll={() => setActiveTab("relations")}
            />
          ) : null}
          {resolvedRecord ? (
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
              entityKind={entity}
              entityId={id}
              showEntityLink={false}
            />
          </div>
        ) : undefined
      }
    />
  );
}
