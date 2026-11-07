import {
  generatedRelations,
  relationTables,
} from "./generated/entity-tables.gen";
// Canonical definitions are shared; relational query assembly stays here.
export * from "~/server/db/retained-tables";
export * from "./generated/entity-tables.gen";

import {
  defineRelations,
  type RelationsBuilder,
  type ExtractTablesFromSchema,
} from "drizzle-orm";

const tables = relationTables;

const entityExternalIdRelations = (
  r: RelationsBuilder<ExtractTablesFromSchema<typeof tables>>,
) => ({
  entityExternalId: {
    // Entity ids are unique across tables, so the product side of a row is
    // exact without a kind filter.
    product: r.one.product({
      from: [r.entityExternalId.entityId],
      to: [r.product.id],
      alias: "productExternalIds",
    }),
    recipe: r.one.recipe({
      from: [r.entityExternalId.entityId],
      to: [r.recipe.id],
      alias: "recipeExternalIds",
    }),
    externalSource: r.one.externalSource({
      from: [r.entityExternalId.source],
      to: [r.externalSource.slug],
      optional: false,
    }),
  },
});

const entityAttachmentRelations = (
  r: RelationsBuilder<ExtractTablesFromSchema<typeof tables>>,
) => ({
  entityAttachment: {
    image: r.one.image({
      from: [r.entityAttachment.imageId],
      to: [r.image.id],
      optional: false,
    }),
    product: r.one.product({
      from: [r.entityAttachment.entityId],
      to: [r.product.id],
    }),
    location: r.one.location({
      from: [r.entityAttachment.entityId],
      to: [r.location.id],
    }),
    gardenEntry: r.one.gardenEntry({
      from: [r.entityAttachment.entityId],
      to: [r.gardenEntry.id],
    }),
    recipe: r.one.recipe({
      from: [r.entityAttachment.entityId],
      to: [r.recipe.id],
    }),
    meal: r.one.meal({
      from: [r.entityAttachment.entityId],
      to: [r.meal.id],
    }),
    task: r.one.task({
      from: [r.entityAttachment.entityId],
      to: [r.task.id],
    }),
    purchase: r.one.purchase({
      from: [r.entityAttachment.entityId],
      to: [r.purchase.id],
    }),
    project: r.one.project({
      from: [r.entityAttachment.entityId],
      to: [r.project.id],
    }),
    cookbook: r.one.cookbook({
      from: [r.entityAttachment.entityId],
      to: [r.cookbook.id],
    }),
    vendor: r.one.vendor({
      from: [r.entityAttachment.entityId],
      to: [r.vendor.id],
    }),
  },
});

const ledgerSourceClaimRelations = (
  r: RelationsBuilder<ExtractTablesFromSchema<typeof tables>>,
) => ({
  ledgerSourceClaim: {
    expense: r.one.expense({
      from: [r.ledgerSourceClaim.expenseId],
      to: [r.expense.id],
    }),
    ledgerTransfer: r.one.ledgerTransfer({
      from: [r.ledgerSourceClaim.ledgerTransferId],
      to: [r.ledgerTransfer.id],
    }),
  },
});

const auditLogRelations = (
  r: RelationsBuilder<ExtractTablesFromSchema<typeof tables>>,
) => ({
  auditLog: {
    identity: r.one.entityIdentity({
      from: [r.auditLog.entityId],
      to: [r.entityIdentity.id],
      optional: false,
    }),
    user: r.one.user({
      from: [r.auditLog.userId],
      to: [r.user.id],
      optional: false,
    }),
    device: r.one.device({
      from: [r.auditLog.deviceId],
      to: [r.device.id],
    }),
    run: r.one.run({
      from: [r.auditLog.runId],
      to: [r.run.id],
    }),
  },
});

export const relationalSchema = defineRelations(tables, (r) => ({
  ...generatedRelations(r),
  ...entityExternalIdRelations(r),
  ...entityAttachmentRelations(r),
  ...ledgerSourceClaimRelations(r),
  ...auditLogRelations(r),
  entityIdentity: {
    canonical: r.one.entityIdentity({
      from: r.entityIdentity.mergedIntoId,
      to: r.entityIdentity.id,
      alias: "entityCanonical",
    }),
  },
}));
