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
