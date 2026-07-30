import { auditLogListInput, auditLogListOut } from "@cubby/schemas/audit";
import { getAuditLog } from "~/server/repo/audit-log";
import { createTRPCRouter, protectedProcedure } from "../trpc";

export const auditLogRouter = createTRPCRouter({
  list: protectedProcedure
    .input(auditLogListInput)
    .output(auditLogListOut)
    .query(({ ctx, input }) =>
      getAuditLog(ctx.db, {
        entityType: input.entityType,
        entityId: input.entityId,
        source: input.source,
        createdAtFrom: input.createdAtFrom,
        createdAtTo: input.createdAtTo,
        limit: input.limit,
        cursor: input.cursor,
      }),
    ),
});
