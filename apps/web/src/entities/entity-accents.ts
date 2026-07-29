import type { Entity } from "@cubby/schemas/entity";

/**
 * Per-entity accent inks for decorative chrome: the page-hero accent bar,
 * table row-hover/selected bars, and similar. Each value feeds the
 * `--page-accent` / `--row-accent` CSS variables (styles.css), which default
 * to ultramarine when unset.
 *
 * Warm-Paper Ledger: there is no per-entity warm hue ladder anymore — the live
 * accent is the lone ultramarine (`--primary`), and quieter sections fall to
 * the neutral ink-slate. Status semantics (`--positive`/`--warning`) are the
 * only colored exceptions, kept for the entities whose accent encodes state.
 */
export const ENTITY_ACCENTS: Record<Entity, string> = {
  inventory: "var(--primary)",
  product: "var(--primary)",
  recipe: "var(--primary)",
  cookbook: "var(--primary)",
  ingredient: "var(--slate)",
  location: "var(--slate)",
  meal: "var(--warning)",
  project: "var(--plum)",
  task: "var(--slate)",
  // A quiet roster, not a live money surface — same neutral as location/task.
  vendor: "var(--slate)",
  // On the money path, same as expense.
  purchase: "var(--primary)",
  expense: "var(--primary)",
  image: "var(--slate)",
  "usda-food": "var(--positive)",
};
