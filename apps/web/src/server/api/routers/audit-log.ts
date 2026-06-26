import { auditEntitySchema, auditLogListOut } from "@cubby/schemas/audit";
import { z } from "zod";
import { getAuditLog } from "~/server/repo/audit-log";
import { createTRPCRouter, protectedProcedure } from "../trpc";

export const auditLogRouter = createTRPCRouter({
  list: protectedProcedure
    .input(
      z.object({
        entityType: auditEntitySchema.optional(),
        entityId: z.string().uuid().optional(),
        limit: z.number().min(1).max(500).default(50),
        cursor: z.string().optional(),
      }),
    )
    .output(auditLogListOut)
    .query(({ ctx, input }) =>
      getAuditLog(ctx.db, {
        entityType: input.entityType,
        entityId: input.entityId,
        limit: input.limit,
        cursor: input.cursor,
      }),
    ),
});
