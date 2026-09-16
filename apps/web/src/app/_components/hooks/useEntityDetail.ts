import type { Entity } from "@cubby/schemas/entity";
import {
  isAuditableEntity,
  isGalleryEntity,
} from "@cubby/schemas/entity-manifest";
import type { UnitMapping } from "@cubby/schemas/unitmapping";
import { Clock, ImageIcon } from "lucide-react";
import { createElement, useMemo } from "react";

import type { EditableEntity } from "~/entities/editing/types";
import {
  type EntityDetailUpdateInput,
  type EntityDetailController,
  useEntityDetailController,
} from "~/entities/editing/use-entity-detail-controller";

import { AuditLogList } from "../audit-log/audit-log-list";
import type { DetailSection } from "../data-table/detail-page";
import EntityImageList from "../EntityImageList";

/**
 * Gallery entities whose Images section is NOT this hook's plain read-only
 * list: `product`/`location` show their gallery as the detail page's own
 * hero image strip (a more prominent placement than a supporting section,
 * still driven by `capabilities.images === "gallery"`), and
 * `meal`/`task`/`planting` edit their gallery inline via
 * `EntityPhotosSection` (add/remove, not just display) at a page-chosen
 * position. Deriving a second, generic "Images" section for any of these
 * five would duplicate or contradict that placement.
 */
const CUSTOM_IMAGE_PLACEMENT: ReadonlySet<Entity> = new Set([
  "product",
  "location",
  "meal",
  "task",
  "planting",
]);

/** Base interface for entities that can have images */
interface WithImages {
  images?: Array<{ id: string; url: string; filename: string }>;
}

/** Base interface for entities with an ID (for audit log) */
interface WithId {
  id: string;
}

interface UseEntityDetailOptions<
  E extends EditableEntity,
  TData extends WithId,
> {
  /** The entity type */
  entity: E;
  /** The entity data */
  data: TData;
  /** For entities with unit mappings - function to extract mappings (sync or async) */
  getMappings?: (data: TData) => UnitMapping[];
  /** Custom callback on successful update */
  onSuccess?: () => void;
  /** Optional query keys to invalidate after successful update. */
}

interface UseEntityDetailReturn<TUpdateInput> {
  /** Common sections derived from entity capabilities (images, history) */
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
 * - Building common sections from entity capabilities: History for every
 *   `capabilities.auditable` entity, Images for every `capabilities.images
 *   === "gallery"` entity that doesn't already place its gallery elsewhere
 *   (see `CUSTOM_IMAGE_PLACEMENT`). Unlike the old per-entity declared array,
 *   nothing here can drift from what the manifest actually says.
 */
export function useEntityDetail<
  E extends EditableEntity,
  TData extends WithId & Partial<WithImages>,
  TUpdateInput extends EntityDetailUpdateInput<E>,
>({
  entity,
  data,
  getMappings,
  onSuccess,
}: UseEntityDetailOptions<E, TData>): UseEntityDetailReturn<TUpdateInput> {
  // Set up edit mode
  const editMode = useEntityDetailController<E, TUpdateInput>({
    entity,
    entityId: data.id,
    onSuccess,
  });

  const mappings = useMemo(
    () => (getMappings ? getMappings(data) : []),
    [data, getMappings],
  );

  // Build common sections from entity capabilities. Order matches every
  // declared array this replaces: Images always precedes History.
  const commonSections: DetailSection[] = [];

  if (isGalleryEntity(entity) && !CUSTOM_IMAGE_PLACEMENT.has(entity)) {
    commonSections.push({
      id: "images",
      title: "Images",
      icon: ImageIcon,
      placement: "supporting",
      content: createElement(EntityImageList, {
        images: data.images ?? [],
      }),
    });
  }

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

  return {
    commonSections,
    editMode,
    mappings,
  };
}
