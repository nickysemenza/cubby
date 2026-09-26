import {
  patchProductExternalIdsInput,
  productExternalIdCollisionInput,
  productExternalIdCollisionsOut,
  productLookupUpcOut,
  productMcpDetailOut,
  productMcpOut,
  productResolveNamesInput,
} from "@cubby/schemas/product";
import { upc } from "@cubby/usda-schemas";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { productContract } from "~/contracts/product.contract";
import {
  patchProductExternalIds,
  resolveProductNames,
} from "~/server/repo/product";
import { findProductExternalIdCollisions } from "~/server/repo/product/external-id-collisions";
import { bindShortcodeResolver } from "~/server/repo/shortcode-resolver";
import { verifyProductImages } from "~/server/services/image-verification.service";
import {
  findOrCreateByUPC,
  lookupUPC,
} from "~/server/services/product-orchestration.service";
import { getProductWithFood } from "~/server/services/product.service";

import {
  getRequestContext,
  idParam,
  READ_ONLY_CLOSED,
  READ_ONLY_OPEN,
  registerBatchTool,
  registerRouterTool,
  rejectDuplicateIds,
  respond,
  slimProduct,
  slimProductDetail,
  WRITE_CLOSED,
} from "./_shared";
import { fromContract, mcpResultsEnvelope } from "./contract-envelope";

const productShortcodes = bindShortcodeResolver("product");

/** `{results}` over `product.resolveNames`'s own output — see `mcpResultsEnvelope`. */
const productResolveNamesMcpOut = mcpResultsEnvelope(
  fromContract(productContract.ops.resolveNames),
);

/**
 * `lookup_upc` over the slim product projection.
 *
 * The workflow output carries `productTopLevelOut`, whose nested `images[].id` and
 * `externalIds[].id` are raw uuids — fine inside the app, but a uuid must never
 * reach an MCP payload. `slimProduct` is the same projection every other product
 * tool publishes, so the local match reads identically here and in the entity
 * command's product search results.
 */
const lookupUpcMcpOut = productLookupUpcOut.extend({
  localProduct: productMcpOut.nullable(),
});

export function registerProductTools(server: McpServer) {
  registerRouterTool(server, {
    name: "find_product_external_id_collisions",
    description:
      "Find duplicate live Product external identifiers. Use source for a broad audit, or identifiers for ordered exact (source, kind, externalId) results including missing and unique slots. Pass productId — the product you are about to write these onto — and `unique` splits into `owned_by_this` and `owned_by_other`; without it, `unique` only means the id has ONE live owner, which reads as a clean pass even when that owner is a different product.",
    inputSchema: productExternalIdCollisionInput,
    outputSchema: productExternalIdCollisionsOut,
    annotations: READ_ONLY_CLOSED,
    call: async (context, params) =>
      productExternalIdCollisionsOut.parse(
        await findProductExternalIdCollisions(context.readDb, params),
      ),
  });

  registerBatchTool(server, {
    name: "patch_products_external_ids",
    description:
      "Patch named (source, kind) identifier slots on up to 50 products in request order, without replacing unrelated Product identifiers. A slot holds ONE primary plus any number of secondaries — Amazon lists one item twice, so a product legitimately carries two ASINs. An upsert replaces the primary; pass isPrimary: false to add an additional identifier alongside it, addressed by its own value. Every removal must include the exact current external ID, all of an item's preconditions are checked before it changes anything, and removing a primary promotes the oldest surviving secondary so the slot always has a value standing for it. A failed item does not roll back successful items. Use this to apply an enrichment sweep's identifier findings in one call.",
    itemInputSchema: patchProductExternalIdsInput,
    itemOutputSchema: productMcpDetailOut,
    projectReference: (item) => item.id,
    annotations: WRITE_CLOSED,
    refineItems: rejectDuplicateIds,
    run: async (item, extra) => {
      const context = getRequestContext(extra);
      const id = await productShortcodes.one(context.db, item.id);
      await patchProductExternalIds(context.db, id, item, context.actorContext);
      return respond(
        await getProductWithFood(context.db, context.usdaClient, id),
        slimProductDetail,
      );
    },
  });

  registerBatchTool(server, {
    name: "verify_products_images",
    description:
      'For up to 20 products in request order, fetch every attached Product file from R2, backfill legacy integrity metadata, and record available, missing, or metadata-mismatch state; each result is the refreshed detailed Product. Ordinary entity action="get", entity="product" performs no R2 requests. Input is {items:[{id:"PRD-2ABC"}]}; this is a batch envelope, not {ids:[…]}. Capped lower than other batches because every item makes one R2 round trip per attached file, not a single database write.',
    itemInputSchema: z.object({ id: idParam("product") }),
    itemOutputSchema: productMcpDetailOut,
    projectReference: (item) => item.id,
    // Each item fans out to one R2 fetch PER attached file, so 50 products is a
    // few hundred network round trips inside one Worker invocation. Every other
    // batch here is DB-bound, which is why this is the one that departs from 50.
    maxItems: 20,
    // The refreshed image state is the entire product of this call — a compact
    // list of ids would say nothing about what verification found.
    defaultResultDetail: "full",
    annotations: WRITE_CLOSED,
    refineItems: rejectDuplicateIds,
    run: async (item, extra) => {
      const context = getRequestContext(extra);
      const id = await productShortcodes.one(context.db, item.id);
      await verifyProductImages(context.db, id);
      return respond(
        await getProductWithFood(context.db, context.usdaClient, id),
        slimProductDetail,
      );
    },
  });

  registerRouterTool(server, {
    name: "lookup_upc",
    description:
      "Resolve a UPC barcode to an identity WITHOUT creating anything. Returns all three sources at once: the Product already claiming the barcode, the USDA branded-food match, and the UPC lookup service's record. Use this whenever the question is what a barcode names — verifying a scan, confirming a product page really describes the item you hold, or checking whether a barcode belongs to a bare tool or the kit it ships in. A barcode identifies the PACKAGE, so a kit and its bare-tool variant carry different UPCs; a manufacturer page reached by guessing a URL from a barcode is not evidence. Prefer this over find_or_create_product_by_upc unless you actually intend to create a Product.",
    inputSchema: z.object({ upc }),
    outputSchema: lookupUpcMcpOut,
    annotations: READ_ONLY_OPEN,
    call: async (context, params) => {
      const result = await lookupUPC(
        context.readDb,
        context.usdaClient,
        context.upcLookupClient,
        params.upc,
      );
      return {
        ...result,
        localProduct: result.localProduct
          ? respond(result.localProduct, slimProduct)
          : null,
      };
    },
  });

  registerRouterTool(server, {
    name: "find_or_create_product_by_upc",
    description:
      "Find or create a product by UPC barcode. Checks local DB, then USDA, then UPC lookup service. This WRITES — it mints a Product when nothing matches, using whatever name the lookup returned. To only ask what a barcode names, use lookup_upc instead.",
    inputSchema: z.object({
      upc,
      defaultName: z
        .string()
        .optional()
        .describe("Fallback name if not found in any database"),
    }),
    outputSchema: productMcpOut.extend({
      warnings: z
        .array(z.string())
        .optional()
        .describe(
          "Best-effort follow-ups that failed after the product was saved, e.g. the cover-photo import.",
        ),
    }),
    annotations: WRITE_CLOSED,
    call: async (context, params) => {
      const { product, sideEffects } = await findOrCreateByUPC(
        context.db,
        context.usdaClient,
        context.upcLookupClient,
        params.upc,
        params.defaultName,
        context.actorContext,
      );
      return {
        ...respond(product, slimProduct),
        warnings: sideEffects.warnings,
      };
    },
  });

  registerRouterTool(server, {
    name: "resolve_products",
    description:
      "Look up which of a list of names already exist as Products, WITHOUT creating anything. Each name gets `exact: true` with the case-insensitive name/alias matches, or `exact: false` with up to 3 contains-search candidates to read by hand. Use it as the dedup pass before an import creates Products (a receipt's lines in one call); the create stays a separate, deliberate `entity`/`entity_batch` call. Unlike resolve_ingredients this never mints a row, because a Product is identity plus cost basis, not just a name.",
    inputSchema: productResolveNamesInput,
    outputSchema: productResolveNamesMcpOut,
    annotations: READ_ONLY_CLOSED,
    call: async (context, params) => ({
      results: await resolveProductNames(context.readDb, params.names),
    }),
  });
}
