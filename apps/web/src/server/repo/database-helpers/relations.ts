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
 * (`mapRelation`, `mapImages`,
 * `Array.filter(deletedAt === null)`) remain as backstops and still cover the
 * relations not yet annotated here.
 */

import { type AnyColumn, asc, sql } from "drizzle-orm";
import {
  inventoryEntry,
  location,
  product,
  productExternalId,
  productImage,
  productUnitMappings,
  recipeSection,
  recipeSectionIngredient,
} from "~/server/db/schema";
import { notDeleted } from "./query";

/**
 * A task's parent `project`, optional subject `product`, and own parent task,
 * each as the `{ name, deletedAt }` projection `resolveLiveJoinName`
 * (transform.ts) needs to derive the public relation names — without pulling
 * the rest of either row. Task-only (expense has no self-relation).
 */
const withProjectAndParentTaskNameOnly = {
  with: {
    project: {
      columns: { name: true, shortcode: true, deletedAt: true },
    },
    subjectProduct: {
      columns: { name: true, shortcode: true, deletedAt: true },
    },
    parentTask: {
      columns: { name: true, shortcode: true, deletedAt: true },
    },
  },
} as const;

/**
 * An expense's parent `project` plus its optionally-linked `product`, same
 * `{ name, deletedAt }` projection — resolves `projectName` / `productName`.
 * Expense-only.
 *
 * Also walks `purchase → vendor`, which is what keeps `expenseOut` exposing
 * `vendor` and `orderId` after those stopped being columns on `Expense`: the
 * charge owns them now, so every read resolves them through this join (see
 * `dbExpenseToAPI`). Two extra `{name, deletedAt}`-shaped hops, both on indexed
 * FKs. `purchase.deletedAt` comes along so a soft-deleted charge reads as no
 * vendor rather than a live one, matching how `resolveLiveJoinName` treats every
 * other join here.
 */
const withProjectAndProductNameOnly = {
  with: {
    project: {
      columns: { name: true, shortcode: true, deletedAt: true },
    },
    product: {
      columns: { name: true, shortcode: true, deletedAt: true },
    },
    purchase: {
      columns: {
        id: true,
        shortcode: true,
        orderId: true,
        vendorId: true,
        deletedAt: true,
      },
      with: {
        vendor: {
          columns: { name: true, shortcode: true, deletedAt: true },
        },
      },
    },
  },
} as const;

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

/**
 * Display order for entity images (productImage/locationImage/recipeImage):
 * same shape as sections — explicit sortOrder (first = cover), createdAt/id
 * tie-break for legacy rows that all sit at the 0 default. Exported for the
 * few image loads that don't go through these relation presets.
 */
export const imageOrder = sectionOrder;

export const relations = {
  ingredient: {
    full: {
      with: {
        product: {
          with: {
            unitMappings: true,
            externalIds: true,
            images: {
              orderBy: imageOrder,
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
    list: {
      with: {
        product: {
          where: notDeleted(product),
          with: {
            unitMappings: {
              where: notDeleted(productUnitMappings),
            },
            externalIds: {
              where: notDeleted(productExternalId),
            },
            images: {
              where: notDeleted(productImage),
              orderBy: imageOrder,
              with: {
                image: true,
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
                  orderBy: imageOrder,
                  with: {
                    image: true,
                  },
                },
              },
            },
          },
        },
        images: {
          orderBy: imageOrder,
          with: {
            image: true,
          },
        },
      },
    },
    list: {
      with: {
        ingredient: true,
        images: {
          where: notDeleted(productImage),
          orderBy: imageOrder,
          with: {
            image: true,
          },
        },
        unitMappings: {
          where: notDeleted(productUnitMappings),
        },
        externalIds: {
          where: notDeleted(productExternalId),
        },
        inventoryEntry: {
          where: notDeleted(inventoryEntry),
          with: {
            location: true,
          },
        },
      },
      // Uncorrelated-per-row scalar: how many live expenses (acquisitions +
      // negative exit rows) point at this product. Mirrors the ingredient
      // list's `appearsInRecipes` extras — a raw string hand-qualified to the
      // relational query builder's root alias ("product"), since a
      // Drizzle-typed column ref would get rewritten to that same alias
      // anyway for a same-table column, but a cross-table correlated
      // reference must stay a literal string to survive the rewrite.
      extras: {
        expenseCount:
          sql<number>`(SELECT count(*) FROM "Expense" pu WHERE pu."productId" = "product"."id" AND pu."deletedAt" IS NULL)`.as(
            "expenseCount",
          ),
        // Net basis: SUM(expense.cost) over this product's live expenses.
        // Plain sum IS the net basis — negative rows (refunds, disposals) are
        // real in this ledger. COALESCE matters: a product with no expenses
        // nets $0, not null. Same "hand-qualified alias, no interpolated
        // PgColumn" shape as expenseCount above — see `purchaseExpenseTotal`
        // in repo/purchase.ts for the full warning about why a Drizzle
        // column interpolated into this select field would self-join and
        // silently return 0 for every row.
        expenseTotal:
          sql<number>`(SELECT COALESCE(sum(e."cost"), 0)::double precision FROM "Expense" e WHERE e."productId" = "product"."id" AND e."deletedAt" IS NULL)`.as(
            "expenseTotal",
          ),
      },
    },
  },
  recipe: {
    full: {
      with: {
        // Shortcode only — the source badge links the book, and Cookbook is a
        // handful of rows, so this join is far cheaper than resolving the code
        // per recipe on the client.
        cookbook: { columns: { shortcode: true } },
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
          orderBy: imageOrder,
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
        cookbook: { columns: { shortcode: true } },
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
    list: {
      with: {
        parent: true,
        children: {
          where: notDeleted(location),
        },
        inventoryEntries: {
          where: notDeleted(inventoryEntry),
          with: {
            product: true,
          },
        },
        images: {
          orderBy: imageOrder,
          with: {
            image: true,
          },
        },
      },
    },
    full: {
      with: {
        parent: true,
        children: {
          with: {
            images: {
              orderBy: imageOrder,
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
          orderBy: imageOrder,
          with: {
            image: true,
          },
        },
      },
    },
    withImages: {
      with: {
        images: {
          orderBy: imageOrder,
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
              orderBy: imageOrder,
              with: {
                image: true,
              },
            },
          },
        },
        location: {
          with: {
            images: {
              orderBy: imageOrder,
              with: {
                image: true,
              },
            },
          },
        },
      },
    },
  },
  task: {
    /**
     * Task row + its parent project's and parent task's `{name, deletedAt}` —
     * see `withProjectAndParentTaskNameOnly`.
     */
    withProject: withProjectAndParentTaskNameOnly,
  },
  expense: {
    /**
     * Expense row + its parent project's and linked product's
     * `{name, deletedAt}` — see `withProjectAndProductNameOnly`.
     */
    withProject: withProjectAndProductNameOnly,
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
                shortcode: true,
                name: true,
                servings: true,
                yield: true,
                totals: true,
                // Read by dbMealToAPI: the LINK's deletedAt says the recipe was
                // unplanned, the RECIPE's says it no longer exists. Filtering
                // only the former kept a deleted recipe in the meal and summed
                // its stale totals into the rollup with pending:false.
                deletedAt: true,
              },
            },
          },
        },
      },
    },
  },
} as const;
