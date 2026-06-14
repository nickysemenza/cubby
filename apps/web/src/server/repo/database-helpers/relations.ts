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
 * (`mapRelation`, `extractImagesFromJoinTable`, `addProductSourceMetadata`,
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
        Product: {
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
        Recipe: true,
        RecipeSectionIngredient: {
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
        Ingredient: true,
        unitMappings: true,
        externalIds: true,
        InventoryEntry: {
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
                    Recipe: true,
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
    // (the `ingredient.Recipe` join is load-bearing — it drives the
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
                    Recipe: true,
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
        InventoryEntries: {
          with: {
            Product: true,
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
    full: {
      with: {
        Product: {
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
    // rows are filtered in dbMealToAPI (Drizzle can't WHERE inside `with`).
    full: {
      with: {
        recipes: {
          orderBy: sectionOrder,
          with: {
            recipe: true,
          },
        },
      },
    },
  },
} as const;
