import type { AuditEntityType } from "@cubby/schemas/audit";
import type { Entity } from "@cubby/schemas/entity";
import type { UnitMapping } from "@cubby/schemas/unitmapping";
import { Clock, ImageIcon, Scale } from "lucide-react";
import { createElement, useMemo } from "react";
import { entities } from "~/entities/entities";
import { AuditLogList } from "../audit-log/audit-log-list";
import type { DetailSection } from "../data-table/detail-page";
import EntityImageList from "../EntityImageList";
import { UnitMappingDisplay } from "../units/UnitMappingDisplay";
import { type UseEditModeReturn, useEditMode } from "./useEditMode";

/** Map Entity type to AuditEntityType (they're now the same) */
const entityToAuditType: Partial<Record<Entity, AuditEntityType>> = {
  product: "product",
  location: "location",
  inventory: "inventory",
  recipe: "recipe",
  ingredient: "ingredient",
};

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
  entity: Entity;
  /** The entity data */
  data: TData;
  /** tRPC mutation options for updates */
  mutationOptions: object;
  /** For entities with unit mappings - function to extract mappings (sync or async) */
  getMappings?: (data: TData) => UnitMapping[];
  /** Custom callback on successful update */
  onSuccess?: () => void;
}

interface UseEntityDetailReturn<TUpdateInput> {
  /** Common sections based on entity config (images, unit-mappings, history) */
  commonSections: DetailSection[];
  /** Edit mode state and handlers */
  editMode: UseEditModeReturn<TUpdateInput>;
  /** Loaded unit mappings (empty array if not applicable) */
  mappings: UnitMapping[];
}

/**
 * Hook for managing entity detail pages with common conventions.
 *
 * Handles:
 * - Edit mode state via useEditMode
 * - Async unit mappings loading if getMappings provided
 * - Building common sections based on entity config (images, unit-mappings, history)
 */
export function useEntityDetail<
  TData extends WithId & Partial<WithImages>,
  TUpdateInput,
>({
  entity,
  data,
  mutationOptions,
  getMappings,
  onSuccess,
}: UseEntityDetailOptions<
  TData,
  unknown
>): UseEntityDetailReturn<TUpdateInput> {
  const entityConfig = entities[entity];
  const commonSectionTypes = entityConfig.detail?.commonSections ?? [];

  // Set up edit mode
  const editMode = useEditMode<TUpdateInput>({
    mutationOptions,
    useRouterRefresh: true,
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
          title: "Images",
          icon: ImageIcon,
          content: createElement(EntityImageList, {
            images: data.images ?? [],
          }),
        });
        break;

      case "unit-mappings":
        commonSections.push({
          title: "Unit Mappings",
          icon: Scale,
          content: createElement(UnitMappingDisplay, {
            mappings,
            title: "",
          }),
        });
        break;

      case "history": {
        const auditType = entityToAuditType[entity];
        if (auditType) {
          commonSections.push({
            title: "History",
            icon: Clock,
            content: createElement(AuditLogList, {
              entityType: auditType,
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
