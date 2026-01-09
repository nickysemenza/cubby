import { z } from "zod";
import { activityEntryId, activityTypeId } from "~/schemas/identifiers";
import type { PaginationParams } from "~/schemas/pagination";
import {
  createActivityEntry,
  deleteActivityEntry,
  getLatestEntryByType,
  listActivityEntries,
  updateActivityEntry,
} from "~/server/repo/activity-entry";
import { createTRPCRouter, protectedProcedure } from "../trpc";

// Output schema for activity entry
const activityEntryOut = z.object({
  id: z.string(),
  activityTypeId: z.string(),
  completedAt: z.date(),
  notes: z.string().nullable(),
  createdAt: z.date(),
  images: z.array(
    z.object({
      id: z.string(),
      url: z.string(),
    }),
  ),
});

// List entries for an activity type
const list = protectedProcedure
  .input(
    z.object({
      activityTypeId,
      pagination: z
        .object({
          pageIndex: z.number().min(0).default(0),
          pageSize: z.number().min(1).default(20),
        })
        .optional(),
    }),
  )
  .output(
    z.object({
      items: z.array(activityEntryOut),
      total: z.number(),
    }),
  )
  .query(async ({ ctx, input }) => {
    const pagination: PaginationParams = input.pagination ?? {
      pageIndex: 0,
      pageSize: 20,
    };
    return listActivityEntries(ctx.db, input.activityTypeId, pagination);
  });

// Get latest entry for an activity type
const getLatest = protectedProcedure
  .input(z.object({ activityTypeId }))
  .output(activityEntryOut.nullable())
  .query(async ({ ctx, input }) => {
    return getLatestEntryByType(ctx.db, input.activityTypeId);
  });

// Create activity entry
const create = protectedProcedure
  .input(
    z.object({
      activityTypeId,
      completedAt: z.date().optional(), // defaults to now
      notes: z.string().nullable().optional(),
      imageIds: z.array(z.string()).optional(),
    }),
  )
  .output(activityEntryOut)
  .mutation(async ({ ctx, input }) => {
    return createActivityEntry(
      ctx.db,
      {
        activityTypeId: input.activityTypeId,
        completedAt: input.completedAt ?? new Date(),
        notes: input.notes ?? null,
        imageIds: input.imageIds,
      },
      ctx.actorContext,
    );
  });

// Update activity entry
const update = protectedProcedure
  .input(
    z.object({
      id: activityEntryId,
      completedAt: z.date().optional(),
      notes: z.string().nullable().optional(),
    }),
  )
  .output(activityEntryOut)
  .mutation(async ({ ctx, input }) => {
    return updateActivityEntry(
      ctx.db,
      input.id,
      {
        completedAt: input.completedAt,
        notes: input.notes,
      },
      ctx.actorContext,
    );
  });

// Delete activity entry
const remove = protectedProcedure
  .input(z.object({ id: activityEntryId }))
  .mutation(async ({ ctx, input }) => {
    await deleteActivityEntry(ctx.db, input.id, ctx.actorContext);
    return { success: true };
  });

export const activityEntryRouter = createTRPCRouter({
  list,
  getLatest,
  create,
  update,
  delete: remove,
});
