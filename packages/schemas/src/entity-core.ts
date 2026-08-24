import { z } from "zod";

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
