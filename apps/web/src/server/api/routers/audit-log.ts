import { auditLogListInput, auditLogListOut } from "@cubby/schemas/audit";
import { getAuditLog } from "~/server/repo/audit-log";
import { resolveShortcode } from "~/server/repo/shortcode-resolver";
import { createTRPCRouter, protectedProcedure } from "../trpc";

export const auditLogRouter = createTRPCRouter({
  list: protectedProcedure
    .input(auditLogListInput)
    .output(auditLogListOut)
    .query(async ({ ctx, input }) => {
      const resolved = input.entityId
        ? await resolveShortcode(ctx.db, input.entityId)
        : null;
      if (
        input.entityId &&
        (!resolved ||
          (input.entityType && resolved.entity !== input.entityType))
      ) {
        return { entries: [] };
      }
      return getAuditLog(ctx.db, {
        entityType: input.entityType,
        entityId: resolved?.id,
        source: input.source,
        createdAtFrom: input.createdAtFrom,
        createdAtTo: input.createdAtTo,
        limit: input.limit,
        cursor: input.cursor,
      });
    }),
});
