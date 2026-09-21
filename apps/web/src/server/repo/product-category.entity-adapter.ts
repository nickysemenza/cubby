import {
  defineEntityAdapter,
  entityMutationReferences,
} from "~/server/entity-kernel/adapter";

import {
  createProductCategory,
  deleteProductCategories,
  getProductCategoryByShortcode,
  listProductCategories,
  PRODUCT_CATEGORY_DELETE_EDGE_POLICY,
  updateProductCategory,
} from "./product-category";

export const productCategoryEntityAdapter = defineEntityAdapter({
  entity: "productCategory",
  lifecycle: { delete: PRODUCT_CATEGORY_DELETE_EDGE_POLICY },
  repository: {
    get: (ctx, id) => getProductCategoryByShortcode(ctx.db, id),
    list: (ctx, filters, sorts, pagination) =>
      listProductCategories(ctx.db, filters, sorts, pagination),
    create: (ctx, data) =>
      createProductCategory(ctx.db, data, ctx.actorContext),
    update: (ctx, id, data) =>
      updateProductCategory(ctx.db, id, data, ctx.actorContext),
    delete: async (ctx, ids) => {
      await deleteProductCategories(ctx.db, ids, ctx.actorContext);
      return {
        deletedReferences: entityMutationReferences("productCategory", ids),
      };
    },
  },
});
