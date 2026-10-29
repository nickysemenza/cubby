import type { Entity } from "./entity-core";
import {
  entityRoster,
  type auditableEntities,
  type galleryEntities,
} from "./generated/entity-roster.gen";
export const isAuditableEntity = (
  entity: Entity,
): entity is (typeof auditableEntities)[number] =>
  entityRoster[entity].auditable;
export const isGalleryEntity = (
  entity: Entity,
): entity is (typeof galleryEntities)[number] =>
  entityRoster[entity].imageStorage === "gallery";
