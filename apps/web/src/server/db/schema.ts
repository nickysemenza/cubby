// Canonical definitions are shared; relational query assembly stays here.
export * from "~/server/db/retained-tables";
export * from "./generated/entity-tables.gen";
export { entityIdentityRelations } from "~/server/db/entity-identity-schema";

import { relations } from "drizzle-orm";

import {
  auditLog,
  cookbook,
  device,
  entityAttachment,
  entityExternalId,
  entityIdentity,
  expense,
  externalSource,
  gardenEntry,
  image,
  ledgerSourceClaim,
  ledgerTransfer,
  location,
  meal,
  product,
  project,
  purchase,
  recipe,
  run,
  task,
  user,
  vendor,
} from "~/server/db/retained-tables";

export const entityExternalIdRelations = relations(
  entityExternalId,
  ({ one }) => ({
    // Entity ids are unique across tables, so the product side of a row is
    // exact without a kind filter.
    product: one(product, {
      fields: [entityExternalId.entityId],
      references: [product.id],
      relationName: "productExternalIds",
    }),
    recipe: one(recipe, {
      fields: [entityExternalId.entityId],
      references: [recipe.id],
      relationName: "recipeExternalIds",
    }),
    externalSource: one(externalSource, {
      fields: [entityExternalId.source],
      references: [externalSource.slug],
    }),
  }),
);

export const entityAttachmentRelations = relations(
  entityAttachment,
  ({ one }) => ({
    image: one(image, {
      fields: [entityAttachment.imageId],
      references: [image.id],
    }),
    product: one(product, {
      fields: [entityAttachment.entityId],
      references: [product.id],
    }),
    location: one(location, {
      fields: [entityAttachment.entityId],
      references: [location.id],
    }),
    gardenEntry: one(gardenEntry, {
      fields: [entityAttachment.entityId],
      references: [gardenEntry.id],
    }),
    recipe: one(recipe, {
      fields: [entityAttachment.entityId],
      references: [recipe.id],
    }),
    meal: one(meal, {
      fields: [entityAttachment.entityId],
      references: [meal.id],
    }),
    task: one(task, {
      fields: [entityAttachment.entityId],
      references: [task.id],
    }),
    purchase: one(purchase, {
      fields: [entityAttachment.entityId],
      references: [purchase.id],
    }),
    project: one(project, {
      fields: [entityAttachment.entityId],
      references: [project.id],
    }),
    cookbook: one(cookbook, {
      fields: [entityAttachment.entityId],
      references: [cookbook.id],
    }),
    vendor: one(vendor, {
      fields: [entityAttachment.entityId],
      references: [vendor.id],
    }),
  }),
);

export const ledgerSourceClaimRelations = relations(
  ledgerSourceClaim,
  ({ one }) => ({
    expense: one(expense, {
      fields: [ledgerSourceClaim.expenseId],
      references: [expense.id],
    }),
    ledgerTransfer: one(ledgerTransfer, {
      fields: [ledgerSourceClaim.ledgerTransferId],
      references: [ledgerTransfer.id],
    }),
  }),
);

export const auditLogRelations = relations(auditLog, ({ one }) => ({
  identity: one(entityIdentity, {
    fields: [auditLog.entityId],
    references: [entityIdentity.id],
  }),
  user: one(user, {
    fields: [auditLog.userId],
    references: [user.id],
  }),
  device: one(device, {
    fields: [auditLog.deviceId],
    references: [device.id],
  }),
  run: one(run, {
    fields: [auditLog.runId],
    references: [run.id],
  }),
}));
