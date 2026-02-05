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
 * - filterDeleted() for simple arrays with deletedAt
 */

export const relations = {
  ingredient: {
    full: {
      with: {
        Product: {
          with: {
            unitMappings: true,
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
  },
  recipe: {
    full: {
      with: {
        sections: {
          with: {
            ingredients: {
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
