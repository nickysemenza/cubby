import { z } from "zod";
import { createTRPCRouter, protectedProcedure } from "../trpc";
import { getAuditLog, type AuditEntityType } from "~/server/repo/audit-log";

// Schema for entity types
const auditEntityTypeSchema = z.enum([
  "product",
  "location",
  "inventory",
  "recipe",
  "ingredient",
]);

export const auditLogRouter = createTRPCRouter({
  list: protectedProcedure
    .input(
      z.object({
        entityType: auditEntityTypeSchema.optional(),
        entityId: z.string().uuid().optional(),
        limit: z.number().min(1).max(100).default(50),
        cursor: z.string().optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      return getAuditLog(ctx.db, {
        organizationId: ctx.organizationId,
        entityType: input.entityType as AuditEntityType | undefined,
        entityId: input.entityId,
        limit: input.limit,
        cursor: input.cursor,
      });
    }),
});
