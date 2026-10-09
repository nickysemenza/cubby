import { env } from "~/env";
import type { NotionClient } from "~/server/clients/notion";
import { USDAClient } from "~/server/clients/usda";
import type { Database } from "~/server/db";
import { deferredService } from "~/server/deferred-service";
import type { AvailabilityService } from "~/server/services/availability.service";
import type { RecipeCostingService } from "~/server/services/recipe-costing.service";
import { createUpcLookupService } from "~/server/services/upc";
import type { USDAService } from "~/server/services/usda.service";
import { requestUsdaRelease } from "~/server/usda-release/client";
import type { UsdaReleaseRpc } from "~/server/usda-release/rpc";

/**
 * A database's domain services, without the request's auth and actor. Each
 * one loads on first use.
 */
const deferredRecipeCosting = (
  load: () => Promise<RecipeCostingService>,
  database: Database,
): RecipeCostingService =>
  deferredService(load, (loaded) => ({
    database,
    bindTo: (selected, publish) =>
      deferredRecipeCosting(
        async () => (await loaded()).bindTo(selected, publish),
        selected,
      ),
  }));

export const deferredRequestServices = (
  database: Database,
  usdaClient: USDAClient,
) => {
  let pending:
    | Promise<import("./request-services").RequestServices>
    | undefined;
  // Request services hold every domain service; they load on first use.
  const loaded = () =>
    (pending ??= import("./request-services").then((module) =>
      module.buildRequestServices(database, usdaClient),
    ));
  return {
    usdaService: deferredService<USDAService>(
      async () => (await loaded()).usdaService,
      () => ({}),
    ),
    services: {
      availability: deferredService<AvailabilityService>(
        async () => (await loaded()).services.availability,
        () => ({}),
      ),
      recipeCosting: deferredRecipeCosting(
        async () => (await loaded()).services.recipeCosting,
        database,
      ),
    },
  };
};

export const buildCrudServices = (
  database: Database,
  opts?: { usdaRelease?: UsdaReleaseRpc },
) => {
  // Built on first use: each client's SDK would otherwise load into every
  // request, and most requests never call Notion or USDA.
  const notionApiKey = env.NOTION_API_KEY;
  const notionClient = notionApiKey
    ? deferredService<NotionClient>(
        async () =>
          new (await import("~/server/clients/notion")).NotionClient(
            notionApiKey,
          ),
        () => ({}),
      )
    : null;
  const usdaClient = deferredService<USDAClient>(
    async () => new USDAClient(opts?.usdaRelease ?? requestUsdaRelease()),
    () => ({}),
  );
  const upcLookupClient = createUpcLookupService(database);

  return {
    db: database,
    notionClient,
    usdaClient,
    upcLookupClient,
    ...deferredRequestServices(database, usdaClient),
  };
};
