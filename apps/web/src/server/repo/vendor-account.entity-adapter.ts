import {
  defineEntityAdapter,
  entityMutationReferences,
} from "~/server/entity-kernel/adapter";

import {
  createVendorAccount,
  deleteVendorAccounts,
  getVendorAccountByShortcode,
  listVendorAccounts,
  updateVendorAccount,
  VENDOR_ACCOUNT_DELETE_EDGE_POLICY,
} from "./vendor-account";

export const vendorAccountEntityAdapter = defineEntityAdapter({
  entity: "vendorAccount",
  lifecycle: { delete: VENDOR_ACCOUNT_DELETE_EDGE_POLICY },
  repository: {
    get: (ctx, id) => getVendorAccountByShortcode(ctx.db, id),
    list: (ctx, filters, sorts, pagination) =>
      listVendorAccounts(ctx.db, filters, sorts, pagination),
    create: (ctx, data) => createVendorAccount(ctx.db, data, ctx.actorContext),
    update: (ctx, id, data) =>
      updateVendorAccount(ctx.db, id, data, ctx.actorContext),
    delete: async (ctx, ids) => {
      await deleteVendorAccounts(ctx.db, ids, ctx.actorContext);
      return {
        deletedReferences: entityMutationReferences("vendorAccount", ids),
      };
    },
  },
});
