import {
  defineEntityAdapter,
  entityMutationReferences,
} from "~/server/entity-kernel/adapter";

import {
  createDevice,
  DEVICE_DELETE_EDGE_POLICY,
  deleteDevices,
  getDeviceByShortcode,
  listDevices,
  updateDevice,
} from "./device";

export const deviceEntityAdapter = defineEntityAdapter({
  entity: "device",
  lifecycle: { delete: DEVICE_DELETE_EDGE_POLICY },
  repository: {
    get: (ctx, id) => getDeviceByShortcode(ctx.db, id),
    list: (ctx, filters, sorts, pagination) =>
      listDevices(ctx.db, filters, sorts, pagination),
    create: (ctx, data) => createDevice(ctx.db, data, ctx.actorContext),
    update: (ctx, id, data) => updateDevice(ctx.db, id, data, ctx.actorContext),
    delete: async (ctx, ids) => {
      await deleteDevices(ctx.db, ids, ctx.actorContext);
      return {
        deletedReferences: entityMutationReferences("device", ids),
      };
    },
  },
});
