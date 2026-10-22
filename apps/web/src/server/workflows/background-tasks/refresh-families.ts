import { USDAClient } from "~/server/clients/usda";
import { prepareRecipeRefresh } from "~/server/domains/run/service/derived-refresh";
import { requestUsdaRelease } from "~/server/domains/usda-release/service/client";
import {
  createRefreshFamilyHandler,
  type RefreshFamilyPreparation,
} from "~/server/generic/derived-refresh/repo/process";
import { prepareProductConversionCoveragePage } from "~/server/generic/problems/service/problems.service";
import {
  countUnembeddedSearchDocuments,
  prepareSearchDocuments,
  selectUnembeddedSearchDocumentRefs,
} from "~/server/generic/search/repo/search-document";

import {
  enqueueEmbeddingRefs,
  productionEmbeddingRefreshPort,
} from "./embedding";

/** Compose provider preparation outside the database-only publication pass. */
export const createProductionRefreshFamilyHandler = (
  overrides: Partial<RefreshFamilyPreparation> = {},
) =>
  createRefreshFamilyHandler({
    prepareRecipe: prepareRecipeRefresh,
    prepareConversions: (db, options) =>
      prepareProductConversionCoveragePage(
        db,
        options,
        new USDAClient(requestUsdaRelease()),
      ),
    countEmbeddings: async (db) =>
      productionEmbeddingRefreshPort.configured()
        ? countUnembeddedSearchDocuments(
            db,
            productionEmbeddingRefreshPort.config(),
          )
        : null,
    prepareEmbeddings: async (db, options) => {
      if (!productionEmbeddingRefreshPort.configured()) return null;
      const config = productionEmbeddingRefreshPort.config();
      const page = await selectUnembeddedSearchDocumentRefs(
        db,
        config,
        options,
      );
      const prepared = await prepareSearchDocuments(db, page.refs);
      return {
        nextCursor: page.nextCursor,
        pending: page.refs.length,
        publish: async (tx) =>
          (await enqueueEmbeddingRefs(tx, prepared, config)).length,
      };
    },
    ...overrides,
  });

export const refreshFamilyHandler = createProductionRefreshFamilyHandler();
