import { type AnyColumn, and, asc, sql } from "drizzle-orm";

import {
  expenseAttribution,
  inventoryEntry,
  ledgerSourceClaim,
  location,
  locationImage,
  mealImage,
  mealRecipe,
  product,
  productExternalId,
  productImage,
  productUnitMappings,
  cookbook,
  recipe,
  recipeImage,
  recipeSection,
  recipeSectionIngredient,
  taskImage,
} from "~/server/db/schema";
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
// Deep path, never the `database-helpers` barrel: these are top-level const
// initializations, so an import cycle here is a TDZ crash at startup.
import {
  productAcquisitionDateSql,
  productExpenseCountSql,
  productExpenseTotalSql,
} from "~/server/repo/expense-aggregate-sql";
import { stockOnly } from "~/server/repo/inventory/placement";
import { categorySummarySql } from "~/server/repo/product-category-sql";
import { productClassificationEvidenceSql } from "~/server/repo/product/classification-evidence";

import { notDeleted } from "./query";

/**
 * How many distinct components this product contains — non-zero makes it a kit.
 *
 * Counts EDGES, not units, so a 4-pack recorded as one row with `quantity: 4`
 * reads as 1: the column says "made of N things". The detail hero and the list
 * cell both read it, and `productIdsWithComponents` in product/crud.ts selects
 * on the same live-edge predicate — the filter, the cell, and the hero
 * disagreeing is the #428 failure mode.
 */
const productComponentCount = sql<number>`(SELECT count(*) FROM "ProductComponent" pc WHERE pc."parentProductId" = "product"."id" AND pc."deletedAt" IS NULL)`;

/**
 * An expense's parent `project` plus its optionally-linked `product`, same
 * `{ name, deletedAt }` projection — resolves `projectName` / `productName`.
 * Expense-only.
 *
 * Also walks `purchase → vendor`, which is what keeps `expenseOut` exposing
 * `vendor` and `orderId` after those stopped being columns on `Expense`: the
 * charge owns them now, so every read resolves them through this join (see
 * `dbExpenseToAPI`). Two extra `{name, deletedAt}`-shaped hops, both on indexed
 * FKs. `purchase.deletedAt` comes along so a soft-deleted Purchase reads as no
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
        displayLabel: true,
        date: true,
        vendorId: true,
        deletedAt: true,
      },
      with: {
        vendor: {
          columns: {
            name: true,
            shortcode: true,
            // Derives `expenseOut.orderUrl` — the link out to the vendor's own
            // order page — without a second query.
            orderUrlTemplate: true,
            deletedAt: true,
          },
          with: {
            logo: {
              columns: {
                key: true,
                contentType: true,
                renderStatus: true,
                storageStatus: true,
                deletedAt: true,
              },
            },
          },
        },
      },
    },
    attributions: {
      where: notDeleted(expenseAttribution),
      columns: {
        role: true,
        ledgerPartyId: true,
        weight: true,
        deletedAt: true,
      },
      with: { ledgerParty: { columns: { shortcode: true, deletedAt: true } } },
    },
    sourceClaims: {
      where: notDeleted(ledgerSourceClaim),
      columns: {
        source: true,
        sourceKey: true,
        sourceKeyVersion: true,
        normalizedEvidence: true,
        targetAmountAtClaim: true,
        reconciliationDecision: true,
        reconciliationNote: true,
        createdAt: true,
        updatedAt: true,
        deletedAt: true,
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

/**
 * Insertion order for relations hanging off a plain FK, which have no
 * `sortOrder` column to sort by: oldest link first, id breaking the ties
 * createdAt can't (it's the transaction timestamp, identical across one save).
 */
const linkOrder = (t: { createdAt: AnyColumn; id: AnyColumn }) => [
  asc(t.createdAt),
  asc(t.id),
];

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
    images: {
      where: notDeleted(taskImage),
      orderBy: imageOrder,
      with: {
        image: true,
      },
    },
  },
} as const;

/**
 * The identity product a Location IS — the bin, tote or rack itself, as
 * opposed to `inventoryEntries.product`, which is stock held at it. Carries
 * the cover image because a linked location renders from its SKU's photo.
 */
const productCategoryProjection = {
  classificationEvidence: productClassificationEvidenceSql(
    sql`${product.id}`,
  ).as("classificationEvidence"),
  category: categorySummarySql(sql`${product.categoryId}`).as("category"),
};

const locationIdentityProduct = {
  extras: productCategoryProjection,
  with: {
    images: {
      where: notDeleted(productImage),
      orderBy: imageOrder,
      with: {
        image: true,
      },
    },
  },
} as const;

export const relations = {
  ingredient: {
    full: {
      with: {
        product: {
          extras: productCategoryProjection,
          where: notDeleted(product),
          with: {
            unitMappings: { where: notDeleted(productUnitMappings) },
            externalIds: { where: notDeleted(productExternalId) },
            images: {
              where: notDeleted(productImage),
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
          extras: productCategoryProjection,
          where: notDeleted(product),
          // Load-bearing for BOTH the Product column's pill (which shows
          // `product[0]` of a possible +9) and the leading thumbnail (which
          // falls back to these images). Unordered, Postgres was free to
          // return a different brand per request.
          orderBy: linkOrder,
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
        growsPlant: { columns: { shortcode: true } },
        unitMappings: { where: notDeleted(productUnitMappings) },
        externalIds: { where: notDeleted(productExternalId) },
        // Locations that ARE this product — a bin in service, as opposed to
        // `inventoryEntry`, which is stock held somewhere. Scalar columns only;
        // the detail table renders a name, a type and a link.
        locations: { where: notDeleted(location) },
        // A product may be the physical copy for many cookbooks. Filter both
        // sides at the query boundary so the detail projection cannot expose a
        // deleted book or count deleted recipes.
        cookbooks: {
          where: notDeleted(cookbook),
          orderBy: asc(cookbook.name),
          with: {
            recipes: {
              where: notDeleted(recipe),
              columns: { deletedAt: true },
            },
          },
        },
        inventoryEntry: {
          where: notDeleted(inventoryEntry),
          with: {
            location: {
              with: {
                images: {
                  where: notDeleted(locationImage),
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
          where: notDeleted(productImage),
          orderBy: imageOrder,
          with: {
            image: true,
          },
        },
      },
      // Embedded on the detail read for the same reason `servingAsLocations`
      // is: the hero reads it, and a hero fed by a second in-flight query
      // contradicts the Kit Components table beneath it while that query
      // resolves. Same live-edge predicate as the list's `componentCount` and
      // as `productIdsWithComponents` in product/crud.ts — the filter, the
      // cell and the hero must select the same rows.
      extras: {
        ...productCategoryProjection,
        componentCount: productComponentCount.as("componentCount"),
      },
    },
    list: {
      with: {
        ingredient: true,
        growsPlant: { columns: { shortcode: true } },
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
      extras: {
        ...productCategoryProjection,
        // Counts every live line, acquisitions and exits alike. Shared with the
        // ORDER BY and the range filter in product/crud.ts.
        expenseCount: productExpenseCountSql().as("expenseCount"),
        componentCount: productComponentCount.as("componentCount"),
        // Net basis, shared with its ORDER BY and range filter the same way.
        expenseTotal: productExpenseTotalSql().as("expenseTotal"),
        // A Product can be present on several Expense lines and Purchases, in
        // BOTH directions — a sale or disposal is a Purchase too. The column
        // means the latest ACQUISITION, so it reads the shared fragment that
        // the sort and both filters in product/crud.ts also read; the three
        // agreeing by hand is exactly how this shipped showing eBay-sale dates
        // as "purchase date" on 185 products.
        purchaseDate: productAcquisitionDateSql().as("purchaseDate"),
      },
    },
    // Product list rows are hydrated from bounded batch reads in product/crud.
    // Keeping only the scalar/to-one projection here avoids Drizzle building
    // one nested JSON graph for every page row.
    listBase: {
      with: {
        ingredient: true,
        growsPlant: { columns: { shortcode: true } },
      },
      extras: {
        ...productCategoryProjection,
        expenseCount: productExpenseCountSql().as("expenseCount"),
        componentCount: productComponentCount.as("componentCount"),
        expenseTotal: productExpenseTotalSql().as("expenseTotal"),
        purchaseDate: productAcquisitionDateSql().as("purchaseDate"),
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
        // Shortcode + name — the lineage pointer's link needs a real label to
        // show, not just a code (same reasoning as `cookbook` above, plus a name).
        forkedFrom: { columns: { shortcode: true, name: true } },
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
          where: notDeleted(recipeImage),
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
        // Shortcode + name — the lineage pointer's link needs a real label to
        // show, not just a code (same reasoning as `cookbook` above, plus a name).
        forkedFrom: { columns: { shortcode: true, name: true } },
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
        product: locationIdentityProduct,
        children: {
          where: notDeleted(location),
          with: { product: locationIdentityProduct },
        },
        inventoryEntries: {
          // Browse/count surface, so `stockOnly()` per the rule in
          // `inventory/placement.ts`. Without it the cell listed installed
          // fixtures that the sort and both count filters
          // (`locationIdsMeetingInventoryMinimum`, `directItemCountMin/Max`)
          // exclude — "wire spools" rendered 49 chips and sorted as 25.
          //
          // The PRODUCT list's Locations cell is the deliberate opposite; see
          // the note in `product/crud.ts`. Same column helper, opposite correct
          // answer per direction.
          where: and(notDeleted(inventoryEntry), stockOnly()),
          with: {
            // See the `inventory.list` note below: the embedded product's
            // barcode is derived from its primary `gtin` identifier row.
            product: {
              extras: productCategoryProjection,
              with: { externalIds: { where: notDeleted(productExternalId) } },
            },
          },
        },
        images: {
          // Association rows are soft-deletable independently of the Image, so
          // without this a detached image still renders a thumbnail — and would
          // disagree with `imagePresenceFilter`, which excludes it.
          where: notDeleted(locationImage),
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
        product: locationIdentityProduct,
        children: {
          where: notDeleted(location),
          with: {
            // Children carry their identity SKU too — the Contents table shows
            // one row per child bin, and without this every product-linked
            // child renders an empty type with no name to fall back on.
            product: locationIdentityProduct,
            images: {
              where: notDeleted(locationImage),
              orderBy: imageOrder,
              with: {
                image: true,
              },
            },
          },
        },
        // No `inventoryEntries` here: the detail payload's `inventoryItems`
        // come from `location/stock-items.ts` so they share one query with
        // `directItemCount`; the detail page's Contents table reads the
        // inventory list (which includes installed fixtures) on its own.
        images: {
          where: notDeleted(locationImage),
          orderBy: imageOrder,
          with: {
            image: true,
          },
        },
      },
    },
    withImages: {
      with: {
        product: locationIdentityProduct,
        images: {
          where: notDeleted(locationImage),
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
        // `externalIds` is loaded for the LIST too, not only for `full`: a
        // row's barcode is derived from its primary `gtin` identifier now, so
        // without it every inventory row would report itself barcode-less.
        product: {
          extras: productCategoryProjection,
          with: { externalIds: { where: notDeleted(productExternalId) } },
        },
        location: true,
      },
    },
    full: {
      with: {
        product: {
          extras: productCategoryProjection,
          with: {
            unitMappings: { where: notDeleted(productUnitMappings) },
            externalIds: { where: notDeleted(productExternalId) },
            images: {
              where: notDeleted(productImage),
              orderBy: imageOrder,
              with: {
                image: true,
              },
            },
          },
        },
        location: {
          with: {
            product: locationIdentityProduct,
            images: {
              where: notDeleted(locationImage),
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
    // the persisted `totals` used for the cost rollup). `where: notDeleted(mealRecipe)`
    // below filters soft-deleted occurrences; the to-one `recipe` join can't be
    // filtered here, so `dbMealToAPI` keeps `recipe.deletedAt` as a backstop.
    full: {
      with: {
        recipes: {
          where: notDeleted(mealRecipe),
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
                totalsComputedAt: true,
                // Read by dbMealToAPI: the LINK's deletedAt says the recipe was
                // unplanned, the RECIPE's says it no longer exists. Filtering
                // only the former kept a deleted recipe in the meal and summed
                // its stale totals into the rollup with pending:false.
                deletedAt: true,
              },
            },
          },
        },
        images: {
          where: notDeleted(mealImage),
          orderBy: imageOrder,
          with: {
            image: true,
          },
        },
      },
    },
  },
} as const;
