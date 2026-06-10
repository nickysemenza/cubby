import type { Entity } from "@cubby/schemas/entity";

/**
 * Per-entity accent inks for decorative chrome: the page-hero accent bar,
 * table row-hover/selected bars, and similar. Each entry is a [base, light]
 * pair feeding the `--page-accent(-light)` / `--row-accent` CSS variables
 * (styles.css), which default to terracotta when unset. Values stay in the
 * warm oklch family so sections read as different drawers of the same hutch.
 */
export const ENTITY_ACCENTS: Record<Entity, { base: string; light: string }> = {
  inventory: {
    base: "var(--brand-terracotta)",
    light: "var(--brand-terra-light)",
  },
  product: { base: "oklch(0.55 0.07 145)", light: "oklch(0.7 0.07 145)" },
  recipe: { base: "var(--plum)", light: "oklch(0.68 0.12 320)" },
  cookbook: { base: "var(--plum)", light: "oklch(0.68 0.12 320)" },
  ingredient: {
    base: "oklch(0.65 0.12 50)",
    light: "var(--brand-terra-light)",
  },
  location: { base: "var(--slate)", light: "oklch(0.68 0.05 55)" },
  image: { base: "var(--subtle)", light: "oklch(0.75 0.07 90)" },
  "usda-food": { base: "var(--positive)", light: "oklch(0.65 0.1 150)" },
};
