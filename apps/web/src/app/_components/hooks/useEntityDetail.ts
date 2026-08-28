import type { AuditEntityType } from "@cubby/schemas/audit";
import type { Entity } from "@cubby/schemas/entity";
import { entityManifest } from "@cubby/schemas/entity-manifest";
import type { UnitMapping } from "@cubby/schemas/unitmapping";
import { Clock, ImageIcon, Scale } from "lucide-react";
import { createElement, useMemo } from "react";

import type { EditableEntity } from "~/entities/editing/types";
import {
  type EntityDetailController,
  useEntityDetailController,
} from "~/entities/editing/use-entity-detail-controller";
import { entities } from "~/entities/entities";

import { AuditLogList } from "../audit-log/audit-log-list";
import type { DetailSection } from "../data-table/detail-page";
import EntityImageList from "../EntityImageList";
import { UnitMappingDisplay } from "../units/UnitMappingDisplay";

const isAuditableEntity = (entity: Entity): entity is AuditEntityType =>
  entityManifest[entity].auditable;

/** Base interface for entities that can have images */
interface WithImages {
  images?: Array<{ id: string; url: string; filename: string }>;
}

/** Base interface for entities with an ID (for audit log) */
interface WithId {
  id: string;
}

interface UseEntityDetailOptions<TData extends WithId, _TUpdateInput> {
  /** The entity type */
  entity: EditableEntity;
  /** The entity data */
  data: TData;
  /** For entities with unit mappings - function to extract mappings (sync or async) */
  getMappings?: (data: TData) => UnitMapping[];
  /** Custom callback on successful update */
  onSuccess?: () => void;
  /** Optional query keys to invalidate after successful update. */
}

interface UseEntityDetailReturn<TUpdateInput> {
  /** Common sections based on entity config (images, unit-mappings, history) */
  commonSections: DetailSection[];
  /** Edit mode state and handlers */
  editMode: EntityDetailController<TUpdateInput>;
  /** Loaded unit mappings (empty array if not applicable) */
  mappings: UnitMapping[];
}

/**
 * Hook for managing entity detail pages with common conventions.
 *
 * Handles:
 * - Edit mode state via the shared entity detail controller
 * - Async unit mappings loading if getMappings provided
 * - Building common sections based on entity config (images, unit-mappings, history)
 */
export function useEntityDetail<
  TData extends WithId & Partial<WithImages>,
  TUpdateInput,
>({
  entity,
  data,
  getMappings,
  onSuccess,
}: UseEntityDetailOptions<
  TData,
  unknown
>): UseEntityDetailReturn<TUpdateInput> {
  const entityConfig = entities[entity];
  const commonSectionTypes = (entityConfig.detail?.commonSections ??
    []) as readonly ("images" | "unit-mappings" | "history")[];

  // Set up edit mode
  const editMode = useEntityDetailController<TUpdateInput>({
    entity,
    entityId: data.id,
    onSuccess,
  });

  const mappings = useMemo(
    () => (getMappings ? getMappings(data) : []),
    [data, getMappings],
  );

  // Build common sections based on entity config
  const commonSections: DetailSection[] = [];

  for (const sectionType of commonSectionTypes) {
    switch (sectionType) {
      case "images":
        commonSections.push({
          id: "images",
          title: "Images",
          icon: ImageIcon,
          placement: "supporting",
          content: createElement(EntityImageList, {
            images: data.images ?? [],
          }),
        });
        break;

      case "unit-mappings":
        commonSections.push({
          id: "unit-mappings",
          title: "Unit Mappings",
          icon: Scale,
          placement: "supporting",
          content: createElement(UnitMappingDisplay, {
            mappings,
            title: "",
          }),
        });
        break;

      case "history": {
        if (isAuditableEntity(entity)) {
          commonSections.push({
            id: "history",
            title: "History",
            icon: Clock,
            placement: "supporting",
            content: createElement(AuditLogList, {
              entityType: entity,
              entityId: data.id,
              showEntityLink: false,
            }),
          });
        }
        break;
      }
    }
  }

  return {
    commonSections,
    editMode,
    mappings,
  };
}
