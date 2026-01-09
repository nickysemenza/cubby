import { z } from "zod";
import {
  activityTypeId,
  productId,
  unsafeActivityTypeId,
} from "~/schemas/identifiers";
import {
  autocompleteActivityTypes,
  createActivityType,
  deleteActivityType,
  findActivityTypeByProductAndName,
  listActivityTypesByProduct,
  listDueActivityTypes,
  updateActivityType,
} from "~/server/repo/activity-type";
import { createTRPCRouter, protectedProcedure } from "../trpc";

// Output schema for activity type with due status
const activityTypeWithStatusOut = z.object({
  id: z.string(),
  productId: z.string(),
  name: z.string(),
  intervalDays: z.number().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
  lastCompletedAt: z.date().nullable(),
  nextDueAt: z.date().nullable(),
  isOverdue: z.boolean(),
  isDueSoon: z.boolean(),
  product: z.object({
    id: z.string(),
    name: z.string(),
    shortcode: z.string(),
  }),
});

// List activity types for a product
const listByProduct = protectedProcedure
  .input(z.object({ productId }))
  .output(z.array(activityTypeWithStatusOut))
  .query(async ({ ctx, input }) => {
    return listActivityTypesByProduct(ctx.db, input.productId);
  });

// List all due/overdue activity types
const listDue = protectedProcedure
  .input(
    z
      .object({
        overdueOnly: z.boolean().optional(),
        dueSoonDays: z.number().optional(),
      })
      .optional(),
  )
  .output(z.array(activityTypeWithStatusOut))
  .query(async ({ ctx, input }) => {
    return listDueActivityTypes(ctx.db, input ?? {});
  });

// Autocomplete activity names for a product
const autocomplete = protectedProcedure
  .input(z.object({ productId, query: z.string() }))
  .output(z.array(z.object({ id: z.string(), name: z.string() })))
  .query(async ({ ctx, input }) => {
    return autocompleteActivityTypes(ctx.db, input.productId, input.query);
  });

// Create activity type
const create = protectedProcedure
  .input(
    z.object({
      productId,
      name: z.string().min(1),
      intervalDays: z.number().positive().nullable().optional(),
    }),
  )
  .output(
    z.object({
      id: z.string(),
      name: z.string(),
      intervalDays: z.number().nullable(),
    }),
  )
  .mutation(async ({ ctx, input }) => {
    return createActivityType(
      ctx.db,
      {
        productId: input.productId,
        name: input.name,
        intervalDays: input.intervalDays ?? null,
      },
      ctx.actorContext,
    );
  });

// Find or create activity type (for the "loose enum" pattern)
const findOrCreate = protectedProcedure
  .input(
    z.object({
      productId,
      name: z.string().min(1),
      intervalDays: z.number().positive().nullable().optional(),
    }),
  )
  .output(
    z.object({
      id: z.string(),
      name: z.string(),
      intervalDays: z.number().nullable(),
      created: z.boolean(),
    }),
  )
  .mutation(async ({ ctx, input }) => {
    // Check if exists
    const existing = await findActivityTypeByProductAndName(
      ctx.db,
      input.productId,
      input.name,
    );

    if (existing) {
      // Update interval if provided and different
      if (
        input.intervalDays !== undefined &&
        input.intervalDays !== existing.intervalDays
      ) {
        const updated = await updateActivityType(
          ctx.db,
          unsafeActivityTypeId(existing.id),
          { intervalDays: input.intervalDays },
          ctx.actorContext,
        );
        return { ...updated, created: false };
      }
      return { ...existing, created: false };
    }

    // Create new
    const created = await createActivityType(
      ctx.db,
      {
        productId: input.productId,
        name: input.name,
        intervalDays: input.intervalDays ?? null,
      },
      ctx.actorContext,
    );

    return { ...created, created: true };
  });

// Update activity type
const update = protectedProcedure
  .input(
    z.object({
      id: activityTypeId,
      name: z.string().min(1).optional(),
      intervalDays: z.number().positive().nullable().optional(),
    }),
  )
  .output(
    z.object({
      id: z.string(),
      name: z.string(),
      intervalDays: z.number().nullable(),
    }),
  )
  .mutation(async ({ ctx, input }) => {
    return updateActivityType(
      ctx.db,
      input.id,
      {
        name: input.name,
        intervalDays: input.intervalDays,
      },
      ctx.actorContext,
    );
  });

// Delete activity type
const remove = protectedProcedure
  .input(z.object({ id: activityTypeId }))
  .mutation(async ({ ctx, input }) => {
    await deleteActivityType(ctx.db, input.id, ctx.actorContext);
    return { success: true };
  });

export const activityTypeRouter = createTRPCRouter({
  listByProduct,
  listDue,
  autocomplete,
  create,
  findOrCreate,
  update,
  delete: remove,
});
