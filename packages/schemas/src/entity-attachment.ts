/**
 * How a file is attached to an entity (ADR 0006). Gallery entities hold
 * `attachment` rows; a cookbook's single file is its `cover`, a vendor's its
 * `logo`. Kept dependency-free because the database schema imports it.
 */
export const entityAttachmentRoleValues = [
  "attachment",
  "cover",
  "logo",
] as const;
export type EntityAttachmentRole = (typeof entityAttachmentRoleValues)[number];

/** Shared attachment graph facts; database bindings preserve the polymorphic identity pair. */
export const entityAttachmentStorage = {
  table: "EntityAttachment",
  owner: {
    column: "entityId",
    kindColumn: "entityKind",
    foreignKey: "EntityAttachment_entity_fk",
    targetId: "id",
    targetKind: "kind",
  },
  image: { column: "imageId", targetEntity: "image", targetColumn: "id" },
} as const;
