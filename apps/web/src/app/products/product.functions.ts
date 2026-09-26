import type {
  productCreateManyInput,
  productMarkUsdaUnavailableManyInput,
} from "@cubby/schemas/product";
import type { z } from "zod";

import {
  productContract,
  productStreamsContract,
} from "~/contracts/product.contract";
import { ripple } from "~/integrations/tanstack-query/cache-tags";
import { defineOperationDomain } from "~/integrations/tanstack-query/operation-catalog";

export const product = defineOperationDomain(productContract, {
  search: { tags: [["product", "search"]] },
  summaries: { tags: [["product", "summaries"]], cache: "derived-summary" },
  quantitySummaries: { tags: [["product", "quantitySummaries"]] },
  inventoryEntriesByIds: { tags: [["product", "inventoryEntriesByIds"]] },
  quickCreate: { invalidates: ripple.product },
  applyUpcData: { invalidates: ripple.productRecipe },
  findOrCreateByUPC: { invalidates: ripple.productLookup },
  findOrCreateByCode: { invalidates: ripple.productLookup },
  tagOptions: { tags: [["product", "tagOptions"]] },
  categoryDistribution: { tags: [["product", "categoryDistribution"]] },
  manufacturerOptions: { tags: [["product", "manufacturerOptions"]] },
  externalIdSourceOptions: {
    tags: [["product", "externalIdSourceOptions"]],
  },
  getByShortcodes: { tags: [["product", "getByShortcodes"]] },
  projectUses: {
    tags: [
      ["product", "projectUses"],
      ["project", "resource"],
    ],
  },
  purchases: { tags: [["product", "purchases"]] },
  components: {
    tags: [
      ["product", "components"],
      ["product", "component"],
    ],
  },
  kitComponentRows: {
    tags: [
      ["product", "kitComponentRows"],
      ["product", "component"],
    ],
  },
  kitMembership: {
    tags: [
      ["product", "kitMembership"],
      ["product", "component"],
    ],
  },
  setProjectUses: { invalidates: ripple.projectResource },
  discard: { invalidates: ripple.expense },
});

export const productStreams = defineOperationDomain(productStreamsContract);

export const createManyProductsStream = (
  input: z.input<typeof productCreateManyInput>,
  signal?: AbortSignal,
) => productStreams.createMany.open(input, { signal });
export const markProductsUsdaUnavailableStream = (
  input: z.input<typeof productMarkUsdaUnavailableManyInput>,
  signal?: AbortSignal,
) => productStreams.markUsdaUnavailableMany.open(input, { signal });
export const backfillProductUpcImagesStream = (signal?: AbortSignal) =>
  productStreams.backfillUPCImages.open(undefined, { signal });
