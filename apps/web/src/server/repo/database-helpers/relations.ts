/**
 * Predefined relation loaders for common query patterns.
 * Reduces verbosity when fetching entities with their related data.
 *
 * Usage: spread into query options
 * Example: db.query.ingredient.findFirst({ where: ..., ...relations.ingredient.full })
 *
 * SOFT DELETE: Drizzle's relational queries DO support a `where` on a (to-many)
 * nested relation, so prefer `where: notDeleted(table)` directly in the `with` block
 * to exclude soft-deleted rows at query time — that's the durable, correct-by-
 * construction mechanism. (The recipe-usage relations below do this.) Note `where`
 * is only available on to-many relations; a to-one relation — e.g. a section's
 * `recipe` — can't carry one, so when liveness depends on a to-one parent the
 * transform must still filter (see `dbIngredientToAPI`). The transform-layer helpers
 * (`mapRelation`, `extractImagesFromJoinTable`,
 * `Array.filter(deletedAt === null)`) remain as backstops and still cover the
 * relations not yet annotated here.
 */

import { type AnyColumn, asc } from "drizzle-orm";
import { recipeSection, recipeSectionIngredient } from "~/server/db/schema";
import { notDeleted } from "./query";

/**
 * Display order for recipe sections and section ingredients: explicit
 * `sortOrder` first, then createdAt/id so legacy rows (null sortOrder —
 * created before the column existed) come back in a stable, if arbitrary,
 * order instead of plan-dependent heap order. createdAt alone can't break
 * ties: it's the transaction timestamp, identical across one save.
 */
const sectionOrder = (t: {
  sortOrder: AnyColumn;
  createdAt: AnyColumn;
  id: AnyColumn;
}) => [asc(t.sortOrder), asc(t.createdAt), asc(t.id)];

export const relations = {
  ingredient: {
    full: {
      with: {
        product: {
          with: {
            unitMappings: true,
            externalIds: true,
            images: {
              with: {
                image: true,
              },
            },
          },
        },
        recipe: true,
        recipeSectionIngredient: {
          where: notDeleted(recipeSectionIngredient),
          with: {
            recipeSection: {
              with: {
                recipe: true,
              },
            },
          },
        },
      },
    },
  },
  product: {
    full: {
      with: {
        ingredient: true,
        unitMappings: true,
        externalIds: true,
        inventoryEntry: {
          with: {
            location: {
              with: {
                images: {
                  with: {
                    image: true,
                  },
                },
              },
            },
          },
        },
        images: {
          with: {
            image: true,
          },
        },
      },
    },
    list: {
      with: {
        images: {
          with: {
            image: true,
          },
        },
        unitMappings: true,
        externalIds: true,
      },
    },
  },
  recipe: {
    full: {
      with: {
        sections: {
          where: notDeleted(recipeSection),
          orderBy: sectionOrder,
          with: {
            ingredients: {
              where: notDeleted(recipeSectionIngredient),
              orderBy: sectionOrder,
              with: {
                ingredient: {
                  with: {
                    recipe: true,
                  },
                },
              },
            },
          },
        },
        images: {
          with: {
            image: true,
          },
        },
      },
    },
    // Lean variant for the recipe LIST: same nested ingredient graph as `full`
    // (the `ingredient.recipe` join is load-bearing — it drives the
    // "ingredient" vs "recipe" discriminator in sectionIngredientToAPI), but
    // omits `images`, which the list table never renders. Keeps the wire
    // payload and one per-recipe lateral join off the hot list query.
    list: {
      with: {
        sections: {
          where: notDeleted(recipeSection),
          orderBy: sectionOrder,
          with: {
            ingredients: {
              where: notDeleted(recipeSectionIngredient),
              orderBy: sectionOrder,
              with: {
                ingredient: {
                  with: {
                    recipe: true,
                  },
                },
              },
            },
          },
        },
      },
    },
  },
  location: {
    full: {
      with: {
        parent: true,
        children: {
          with: {
            images: {
              with: {
                image: true,
              },
            },
          },
        },
        inventoryEntries: {
          with: {
            product: true,
          },
        },
        images: {
          with: {
            image: true,
          },
        },
      },
    },
    withImages: {
      with: {
        images: {
          with: {
            image: true,
          },
        },
      },
    },
  },
  inventory: {
    list: {
      with: {
        product: true,
        location: true,
      },
    },
    full: {
      with: {
        product: {
          with: {
            unitMappings: true,
            externalIds: true,
            images: {
              with: {
                image: true,
              },
            },
          },
        },
        location: {
          with: {
            images: {
              with: {
                image: true,
              },
            },
          },
        },
      },
    },
  },
  meal: {
    // A meal with its planned recipes (each joined to its recipe summary, incl.
    // the persisted `totals` used for the cost rollup). Soft-deleted mealRecipe
    // rows are filtered in dbMealToAPI as a backstop; this relation can also adopt
    // `where: notDeleted(mealRecipe)` (see the recipe relations above) — not yet
    // annotated.
    full: {
      with: {
        recipes: {
          orderBy: sectionOrder,
          with: {
            // Only the fields dbMealToAPI reads — the full recipe body per planned recipe was pure over-fetch (the list shows name + scaled totals).
            recipe: {
              columns: {
                id: true,
                name: true,
                servings: true,
                yield: true,
                totals: true,
              },
            },
          },
        },
      },
    },
  },
} as const;
