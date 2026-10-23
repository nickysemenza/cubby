import { withTransactionDatabase } from "~/server/db/helpers";
import { registerLocationImageChange } from "~/server/entity-kernel/repo/mutation-side-effects";
import { defineRepository, onDb } from "~/server/entity-kernel/repo/repository";
import { recordChange } from "~/server/generic/changes/repo/change";
import { bindShortcodeResolver } from "~/server/generic/shortcode/repo/shortcode-resolver";

import {
  createLocationRecord,
  deleteLocations,
  LOCATION_DELETE_EDGE_POLICY,
  locationList,
  locationListRead,
  updateLocation,
} from "./crud";
import { getLocationByShortcode } from "./lookup";

const locationShortcodes = bindShortcodeResolver("location");

/**
 * Location image changes enroll vision analysis in the save transaction.
 */
export const locationRepository = defineRepository("location", {
  lifecycle: { delete: LOCATION_DELETE_EDGE_POLICY },
  get: onDb(getLocationByShortcode),
  list: (ctx, filters, sorts, pagination) =>
    locationList(ctx.db, filters, sorts, pagination),
  listRead: (
    ctx,
    filters,
    sorts,
    pagination,
    projection,
    readIntent = "page",
  ) =>
    locationListRead(
      ctx.db,
      filters,
      sorts,
      pagination,
      projection,
      readIntent,
    ),
  create: (ctx, data) =>
    withTransactionDatabase(ctx.db, async (db) => {
      const { output, entityId } = await createLocationRecord(
        db,
        data,
        ctx.actorContext,
      );
      if (data.pendingImageIds?.length)
        await registerLocationImageChange(db, {
          locationId: entityId,
          runId: ctx.actorContext.runId ?? undefined,
        });
      return { output, entityId };
    }),
  createRead: (ctx, data, fields) =>
    withTransactionDatabase(ctx.db, async (db) => {
      const result = await createLocationRecord.read(
        fields,
        db,
        data,
        ctx.actorContext,
      );
      if (data.pendingImageIds?.length)
        await registerLocationImageChange(db, {
          locationId: result.entityId,
          runId: ctx.actorContext.runId ?? undefined,
        });
      return result;
    }),
  update: async (ctx, shortcode, data) => {
    const entityId = await locationShortcodes.one(ctx.db, shortcode);
    const imagesChanged =
      (data.pendingImageIds?.length ?? 0) > 0 ||
      (data.removeImageIds?.length ?? 0) > 0;
    // The description a removed last image leaves behind is cleared in the
    // update's transaction; the vision refresh and embedding tasks publish
    // only after its commit, so none of them reads the pre-update row.
    return withTransactionDatabase(ctx.db, async (transactionDb) => {
      const { location: updated, detachedImageKeys } = await updateLocation(
        transactionDb,
        entityId,
        data,
        ctx.actorContext,
      );
      if (imagesChanged)
        await registerLocationImageChange(transactionDb, {
          locationId: entityId,
          runId: ctx.actorContext.runId ?? undefined,
        });
      return {
        output: updated,
        entityId,
        detachedImageKeys,
      };
    });
  },
  updateRead: async (ctx, shortcode, data, fields) => {
    const entityId = await locationShortcodes.one(ctx.db, shortcode);
    const imagesChanged =
      (data.pendingImageIds?.length ?? 0) > 0 ||
      (data.removeImageIds?.length ?? 0) > 0;
    return withTransactionDatabase(ctx.db, async (transactionDb) => {
      const result = await updateLocation.read(
        fields,
        transactionDb,
        entityId,
        data,
        ctx.actorContext,
      );
      if (imagesChanged)
        await registerLocationImageChange(transactionDb, {
          locationId: entityId,
          runId: ctx.actorContext.runId ?? undefined,
        });
      return result;
    });
  },
  delete: async (ctx, shortcodes) => {
    const ids = await locationShortcodes.all(ctx.db, shortcodes);
    const result = await deleteLocations(ctx.db, ids, ctx.actorContext);
    await recordChange(ctx.db, { kind: "source", categories: ["location"] });
    return result;
  },
});
