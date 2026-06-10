/**
 * Predefined relation loaders for common query patterns.
 * Reduces verbosity when fetching entities with their related data.
 *
 * Usage: spread into query options
 * Example: db.query.ingredient.findFirst({ where: ..., ...relations.ingredient.full })
 *
 * IMPORTANT: Drizzle's relational queries don't support WHERE clauses in `with` blocks,
 * so soft-deleted related items will be included in query results. You MUST filter them
 * out in transformation functions using helpers like:
 * - extractImagesFromJoinTable() for image join tables
 * - mapRelation() for general relation arrays
 * - addProductSourceMetadata() for unit mappings
 * - Array.filter(item => item.deletedAt === null) for simple arrays with deletedAt
 */

import { type AnyColumn, asc } from "drizzle-orm";

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
          orderBy: sectionOrder,
          with: {
            ingredients: {
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
          orderBy: sectionOrder,
          with: {
            ingredients: {
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
} as const;
