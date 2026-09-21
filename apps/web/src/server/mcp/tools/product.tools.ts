import {
  patchProductExternalIdsInput,
  productExternalIdCollisionInput,
  productExternalIdCollisionsOut,
  productLookupUpcOut,
  productMcpDetailOut,
  productMcpOut,
  productResolveNamesInput,
} from "@cubby/schemas/product";
import { productComponentsInput } from "@cubby/schemas/product-components";
import { upc } from "@cubby/usda-schemas";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { productContract } from "~/contracts/product.contract";

import {
  getCaller,
  idParam,
  READ_ONLY_CLOSED,
  READ_ONLY_OPEN,
  registerBatchTool,
  registerMcpTool,
  registerRouterTool,
  rejectDuplicateIds,
  respond,
  slimProduct,
  slimProductDetail,
  WRITE_CLOSED,
} from "./_shared";
import {
  fromContract,
  mcpItemsEnvelope,
  mcpResultsEnvelope,
} from "./contract-envelope";

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

/** `{items}` over `product.components`'s own output — see `mcpItemsEnvelope`. */
const productComponentsMcpOut = mcpItemsEnvelope(
  fromContract(productContract.ops.components),
);

export function registerProductTools(server: McpServer) {
  registerMcpTool(server, {
    name: "find_product_external_id_collisions",
    description:
      "Find duplicate live Product external identifiers. Use source for a broad audit, or identifiers for ordered exact (source, kind, externalId) results including missing and unique slots. Pass productId — the product you are about to write these onto — and `unique` splits into `owned_by_this` and `owned_by_other`; without it, `unique` only means the id has ONE live owner, which reads as a clean pass even when that owner is a different product.",
    inputSchema: productExternalIdCollisionInput,
    outputSchema: productExternalIdCollisionsOut,
    annotations: READ_ONLY_CLOSED,
    handler: (params, extra) =>
      getCaller(extra).product.externalIdCollisions(params),
  });

  registerMcpTool(server, {
    name: "patch_product_external_ids",
    description:
      "Patch named (source, kind) identifier slots without replacing unrelated Product identifiers. A slot holds ONE primary plus any number of secondaries — Amazon lists one item twice, so a product legitimately carries two ASINs. An upsert replaces the primary; pass isPrimary: false to add an additional identifier alongside it, addressed by its own value. Every removal must include the exact current external ID, all preconditions are checked before anything changes, and removing a primary promotes the oldest surviving secondary so the slot always has a value standing for it.",
    inputSchema: patchProductExternalIdsInput,
    outputSchema: productMcpDetailOut,
    annotations: WRITE_CLOSED,
    handler: async (params, extra) =>
      respond(
        await getCaller(extra).product.patchExternalIds(params),
        slimProductDetail,
      ),
  });

  registerBatchTool(server, {
    name: "patch_products_external_ids",
    description:
      "Patch identifier slots on up to 50 products in request order. Each item uses the same validation and preconditions as patch_product_external_ids; a failed item does not roll back successful items. Use this to apply an enrichment sweep's identifier findings in one call.",
    itemInputSchema: patchProductExternalIdsInput,
    itemOutputSchema: productMcpDetailOut,
    projectReference: (item) => item.id,
    annotations: WRITE_CLOSED,
    refineItems: rejectDuplicateIds,
    run: async (caller, item) =>
      respond(await caller.product.patchExternalIds(item), slimProductDetail),
  });

  registerMcpTool(server, {
    name: "verify_product_images",
    description:
      'Fetch every attached Product file from R2, backfill legacy integrity metadata, and record available, missing, or metadata-mismatch state. Returns the refreshed detailed Product; ordinary entity action="get", entity="product" performs no R2 requests.',
    inputSchema: z.object({ id: idParam("product") }),
    outputSchema: productMcpDetailOut,
    annotations: WRITE_CLOSED,
    handler: async (params, extra) =>
      respond(
        await getCaller(extra).product.verifyImages(params.id),
        slimProductDetail,
      ),
  });

  registerBatchTool(server, {
    name: "verify_products_images",
    description:
      'Run verify_product_images across up to 20 products in request order. Input is {items:[{id:"PRD-2ABC"}]}; this is a batch envelope, not {ids:[…]}. Capped lower than other batches because every item makes one R2 round trip per attached file, not a single database write.',
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
    run: async (caller, item) =>
      respond(await caller.product.verifyImages(item.id), slimProductDetail),
  });

  registerMcpTool(server, {
    name: "lookup_upc",
    description:
      "Resolve a UPC barcode to an identity WITHOUT creating anything. Returns all three sources at once: the Product already claiming the barcode, the USDA branded-food match, and the UPC lookup service's record. Use this whenever the question is what a barcode names — verifying a scan, confirming a product page really describes the item you hold, or checking whether a barcode belongs to a bare tool or the kit it ships in. A barcode identifies the PACKAGE, so a kit and its bare-tool variant carry different UPCs; a manufacturer page reached by guessing a URL from a barcode is not evidence. Prefer this over find_or_create_product_by_upc unless you actually intend to create a Product.",
    inputSchema: z.object({ upc }),
    outputSchema: lookupUpcMcpOut,
    annotations: READ_ONLY_OPEN,
    handler: async (params, extra) => {
      const result = await getCaller(extra).product.lookupUpc({
        upc: params.upc,
      });
      return {
        ...result,
        localProduct: result.localProduct
          ? respond(result.localProduct, slimProduct)
          : null,
      };
    },
  });

  registerMcpTool(server, {
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
    outputSchema: productMcpOut,
    annotations: WRITE_CLOSED,
    handler: async (params, extra) => {
      const caller = getCaller(extra);
      const { product } = await caller.product.findOrCreateByUPC({
        upc: params.upc,
        defaultName: params.defaultName,
      });
      return respond(product, slimProduct);
    },
  });

  registerRouterTool(server, {
    name: "resolve_products",
    description:
      "Look up which of a list of names already exist as Products, WITHOUT creating anything. Each name gets `exact: true` with the case-insensitive name/alias matches, or `exact: false` with up to 3 contains-search candidates to read by hand. Use it as the dedup pass before an import creates Products (a receipt's lines in one call); the create stays a separate, deliberate `entity`/`entity_batch` call. Unlike resolve_ingredients this never mints a row, because a Product is identity plus cost basis, not just a name.",
    inputSchema: productResolveNamesInput,
    outputSchema: productResolveNamesMcpOut,
    annotations: READ_ONLY_CLOSED,
    call: async (caller, params) => ({
      results: await caller.product.resolveNames({ names: params.names }),
    }),
  });

  registerRouterTool(server, {
    name: "list_product_components",
    description:
      "List what's inside one kit or multi-pack Product — the ProductComponent edge. A kit Product (a combo tool kit, a multi-pack, a bundle) is a Product like any other, with its OWN UPC, model, ASIN, image, and purchase history; this is the only place that records what it's MADE OF. One row per distinct component: a 4-pack of one part is a single row at quantity 4, a 9-piece kit is nine separate rows. The kit keeps its OWN Expense — it is never split into per-component expenses. Instead each row's `price` is the component PRODUCT's effective price, which ALREADY BLENDS its own purchase history with its quantity-weighted share of every kit it belongs to (that share being the kit's cost × this quantity ÷ the kit's total component units, derived at read time). So do NOT compute a share yourself on top of this number — it is already in there, and doing so double-counts. A part that was only ever bought inside a kit still returns a real price here, from the kit. An explicit price set on the component product overrides the blend entirely. For the reverse question — every kit a Product is listed inside — read that Product's own detail page; the transpose has no separate MCP tool.",
    inputSchema: productComponentsInput,
    // `{items}`, like every other list tool — the router's own array root is a
    // shape the MCP SDK rejects outright. See `productComponentsMcpOut`.
    outputSchema: productComponentsMcpOut,
    annotations: READ_ONLY_CLOSED,
    call: async (caller, params) => ({
      items: await caller.product.components(params),
    }),
  });
}
