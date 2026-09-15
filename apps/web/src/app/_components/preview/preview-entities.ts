import type { BrowserRoutedEntity } from "@cubby/schemas/entity-manifest";

/** The typed compact-preview capability roster, shared by every inspector. */
export const hoverPreviewEntities = [
  "recipe",
  "ingredient",
  "product",
  "usda-food",
  "cookbook",
  "location",
  "inventory",
  "meal",
  "project",
  "task",
  "expense",
  "purchase",
  "vendor",
  "financialAccount",
  "financialTransaction",
  "wish",
  "image",
  "planting",
  "gardenEntry",
] as const satisfies readonly BrowserRoutedEntity[];

export type HoverPreviewEntity = (typeof hoverPreviewEntities)[number];
