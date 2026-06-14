import type { Entity } from "@cubby/schemas/entity";

/**
 * Per-entity accent inks for decorative chrome: the page-hero accent bar,
 * table row-hover/selected bars, and similar. Each value feeds the
 * `--page-accent` / `--row-accent` CSS variables (styles.css), which default
 * to terracotta when unset. Values stay in the warm oklch family so sections
 * read as different drawers of the same hutch.
 */
export const ENTITY_ACCENTS: Record<Entity, string> = {
  inventory: "var(--brand-terracotta)",
  product: "oklch(0.55 0.07 145)",
  recipe: "var(--plum)",
  cookbook: "var(--plum)",
  ingredient: "oklch(0.65 0.12 50)",
  location: "var(--slate)",
  meal: "var(--warning)",
  image: "var(--subtle)",
  "usda-food": "var(--positive)",
};
