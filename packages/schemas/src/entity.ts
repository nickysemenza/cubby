import { z } from "zod";

// The polymorphic image `entityType` column values. These UPPERCASE storage
// keys are the image-bearing entities; the source of truth for WHICH entities
// have images is `imageEntities` in entity-manifest.ts (this module can't import
// it — that would cycle). entity-manifest.unit.test.ts asserts the two stay in
// sync, so flipping `hasImages` on the manifest forces an update here.
export const entityImage = z.enum([
  "PRODUCT",
  "LOCATION",
  "RECIPE",
  "COOKBOOK",
  "PROJECT",
  // A purchase's documents — the emailed PDF invoice and/or a photo of the paper
  // slip. Same join-table machinery as the galleries above; the PDF renders in
  // an iframe rather than as a thumbnail (see `isDocumentFile`).
  "PURCHASE",
]);
export type EntityImage = z.infer<typeof entityImage>;

/** All entity types in the system */
export const entitySchema = z.enum([
  "ingredient",
  "product",
  "recipe",
  "cookbook",
  "location",
  "inventory",
  "meal",
  "project",
  "task",
  // Vendor ──< Purchase ──< Expense. A `purchase` is a vendor order/receipt event
  // (identified by its `orderId` when the vendor issues one); an `expense` is
  // one categorized line of spend, and all money lives there.
  "vendor",
  "purchase",
  "expense",
  "financialAccount",
  "financialTransaction",
  "usda-food",
  "image",
]);
export type Entity = z.infer<typeof entitySchema>;

export const entityRefFields = {
  entityType: entitySchema,
  entityId: z.string(),
};

export const entityRefSchema = z.object(entityRefFields);
export type EntityRef = z.infer<typeof entityRefSchema>;
