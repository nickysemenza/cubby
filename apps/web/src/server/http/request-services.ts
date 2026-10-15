import type { USDAClient } from "~/server/clients/usda";
import type { Database } from "~/server/db";
import {
  findProductsByFoodIdentifier,
  getFoodLookupsForLinkedProducts,
} from "~/server/domains/product/repo/lookup";
import {
  countProductsByFoodIdentifiers,
  findProductsByFoodIdentifiers,
} from "~/server/domains/product/repo/lookup";
import { AvailabilityService } from "~/server/domains/recipe/service/availability.service";
import { RecipeCostingService } from "~/server/domains/recipe/service/recipe-costing.service";
import { USDAService } from "~/server/domains/usda-food/service/usda.service";

/** Loaded by async service use, rather than every authenticated request. */
export const buildRequestServices = (
  database: Database,
  usdaClient: USDAClient,
) => ({
  usdaService: new USDAService(
    usdaClient,
    async (lookup) => await findProductsByFoodIdentifier(database, lookup),
    async () => await getFoodLookupsForLinkedProducts(database),
    async (lookups) => await findProductsByFoodIdentifiers(database, lookups),
    async (lookups) => await countProductsByFoodIdentifiers(database, lookups),
  ),
  services: {
    availability: new AvailabilityService(database, usdaClient),
    recipeCosting: new RecipeCostingService(database, usdaClient),
  },
});

export type RequestServices = ReturnType<typeof buildRequestServices>;
