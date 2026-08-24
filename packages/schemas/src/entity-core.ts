import { z } from "zod";

/** All entity types in the system. Kept cycle-free for manifest derivations. */
export const entitySchema = z.enum([
  "ingredient",
  "product",
  "recipe",
  "cookbook",
  "location",
  "inventory",
  "ledgerParty",
  "ledgerTransfer",
  "meal",
  "project",
  "task",
  "vendor",
  "purchase",
  "expense",
  "financialAccount",
  "financialTransaction",
  "wish",
  "usda-food",
  "image",
]);
export type Entity = z.infer<typeof entitySchema>;
