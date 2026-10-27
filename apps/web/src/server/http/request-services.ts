import type { RawProductOutput } from "@cubby/schemas/product-raw-read";
import type { FoodSummaryWithLinkedProducts } from "@cubby/schemas/usda";

import type { USDAClient } from "~/server/clients/usda";
import type { Database } from "~/server/db";
import { expenseLineRoleClassifier } from "~/server/domains/expense/service/expense-line-role";
import {
  findProductsByFoodIdentifier,
  getFoodLookupsForLinkedProducts,
} from "~/server/domains/product/repo/lookup";
import {
  countProductsByFoodIdentifiers,
  findProductsByFoodIdentifiers,
} from "~/server/domains/product/repo/lookup";
import { RecipeCostingService } from "~/server/domains/recipe/repo/recipe-costing";
import { AvailabilityService } from "~/server/domains/recipe/service/availability.service";
import { USDAService } from "~/server/domains/usda-food/service/usda.service";
import { readPublicEntityRows } from "~/server/generic/derived/service/public-read";

/** Loaded by async service use, rather than every authenticated request. */
export const buildRequestServices = (
  database: Database,
  usdaClient: USDAClient,
) => {
  const publicLinkedProducts = async (
    groups: readonly RawProductOutput[][],
  ): Promise<FoodSummaryWithLinkedProducts["linkedProducts"][]> => {
    const rawRows = groups.flat();
    if (rawRows.length === 0) return groups.map(() => []);
    // Duplicate matches retain their food grouping; current facts load once per page.
    const rows = await readPublicEntityRows({
      db: database,
      entity: "product",
      projection: "output",
      rows: rawRows,
    });
    let offset = 0;
    return groups.map((group) => {
      const result = rows.slice(offset, offset + group.length);
      offset += group.length;
      return result;
    });
  };
  return {
    usdaService: new USDAService(
      usdaClient,
      async (lookup) => {
        const groups = await publicLinkedProducts([
          await findProductsByFoodIdentifier(database, lookup),
        ]);
        return groups[0] ?? [];
      },
      async () => await getFoodLookupsForLinkedProducts(database),
      async (lookups) =>
        publicLinkedProducts(
          await findProductsByFoodIdentifiers(database, lookups),
        ),
      async (lookups) =>
        await countProductsByFoodIdentifiers(database, lookups),
    ),
    services: {
      availability: new AvailabilityService(database, usdaClient),
      recipeCosting: new RecipeCostingService(database, usdaClient),
      expenseLineRole: expenseLineRoleClassifier(),
    },
  };
};

export type RequestServices = ReturnType<typeof buildRequestServices>;
