import { z } from "zod";
import { auditEntitySchema } from "./audit";
import { auditSourceSchema } from "./context";

const auditLogActionSchema = z.enum(["create", "update", "delete"]);
const auditLogChangeSchema = z.object({
  from: z.unknown(),
  to: z.unknown(),
});

export const auditLogUserOut = z
  .object({
    id: z.string(),
    name: z.string().nullable(),
    email: z.string(),
    image: z.string().nullable(),
  })
  .nullable();

export const auditLogEntryOut = z.object({
  id: z.uuid(),
  entityType: auditEntitySchema,
  entityId: z.uuid(),
  action: auditLogActionSchema,
  changes: z.record(z.string(), auditLogChangeSchema).nullable(),
  userId: z.string(),
  source: auditSourceSchema,
  createdAt: z.date(),
  user: auditLogUserOut,
});

export const auditLogListOut = z.object({
  entries: z.array(auditLogEntryOut),
  nextCursor: z.string().optional(),
});
export type AuditLogListOut = z.infer<typeof auditLogListOut>;
