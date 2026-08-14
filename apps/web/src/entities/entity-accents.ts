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
 *
 * The single identity hue is aubergine (`--plum`), reserved by DESIGN.md for
 * the cooking domain. It is not a general-purpose accent: adding a third
 * entity to it re-opens the per-entity hue ladder this file exists to close.
 */
export const ENTITY_ACCENTS: Record<Entity, string> = {
  inventory: "var(--primary)",
  product: "var(--primary)",
  // The reserved identity colour, finally on the domain it names. DESIGN.md
  // calls aubergine "the reserved identity color for recipes and cookbooks",
  // and `--plum`'s own definition in styles.css says "recipe/cookbook accent"
  // — it had simply been wired to projects and wishes instead, leaving the
  // cooking domain chromatically identical to the expense ledger.
  recipe: "var(--plum)",
  cookbook: "var(--plum)",
  ingredient: "var(--slate)",
  location: "var(--slate)",
  meal: "var(--warning)",
  // Live working surface on the money path, like the purchase/expense it ties
  // together — not a second identity hue.
  project: "var(--primary)",
  task: "var(--slate)",
  // A quiet roster, not a live money surface — same neutral as location/task.
  vendor: "var(--slate)",
  // On the money path, same as expense.
  purchase: "var(--primary)",
  expense: "var(--primary)",
  financialAccount: "var(--slate)",
  financialTransaction: "var(--primary)",
  // A quiet roster, same neutral as vendor.
  wish: "var(--slate)",
  image: "var(--slate)",
  "usda-food": "var(--positive)",
};
