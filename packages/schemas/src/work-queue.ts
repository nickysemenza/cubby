import { z } from "zod";

import { ledgerPartyShortcode } from "./identifiers";
import { problemRowSchema } from "./problems";

export const workQueueMemberSchema = z.object({
  id: ledgerPartyShortcode,
  name: z.string(),
});

/** Routing reflects the evidence needed for this work, not who owns the item. */
export const workWaitingForSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("either") }),
  z.object({
    kind: z.literal("members"),
    members: z.array(workQueueMemberSchema).min(1),
  }),
  z.object({ kind: z.literal("unresolved"), reason: z.string().min(1) }),
]);

export const workQueueKindSchema = z.enum(["research", "review", "repair"]);
export const workQueueSourceSchema = z.enum([
  "research",
  "email",
  "finding",
  "reconciliation",
  "account",
  "problem",
]);

export const workQueueRowSchema = problemRowSchema
  .omit({
    subtitle: true,
    badges: true,
  })
  .extend({
    entity: problemRowSchema.shape.entity.nullable(),
    id: problemRowSchema.shape.id.nullable(),
    problemKey: z.string().min(1).optional(),
    key: z.string().min(1),
    source: workQueueSourceSchema,
    kind: workQueueKindSchema,
    reason: z.string(),
    nextAction: z.string(),
    waitingFor: workWaitingForSchema,
  })
  .refine(
    (row) =>
      (row.entity !== null &&
        row.id !== null &&
        row.problemKey === undefined) ||
      (row.entity === null && row.id === null && row.problemKey !== undefined),
    { message: "Work must name a source record or a Problems diagnostic." },
  );

export const workQueuePageInput = z.object({
  pageIndex: z.number().int().nonnegative().default(0),
  pageSize: z.number().int().min(1).max(100).default(25),
  query: z.string().max(500).optional(),
  kind: workQueueKindSchema.optional(),
  source: workQueueSourceSchema.optional(),
});

/** Household UI filters select routing metadata; they confer no source access. */
export const workQueueHouseholdInput = workQueuePageInput.extend({
  waitingFor: z
    .union([
      z.enum(["all", "me", "either", "unresolved"]),
      ledgerPartyShortcode,
    ])
    .default("all"),
});

export const workQueueOutSchema = z.object({
  items: z.array(workQueueRowSchema),
  members: z.array(workQueueMemberSchema),
  meta: z.object({
    pageIndex: z.number().int().nonnegative(),
    pageSize: z.number().int().positive(),
    totalCount: z.number().int().nonnegative(),
  }),
});

export type WorkQueueRow = z.infer<typeof workQueueRowSchema>;
export type WorkQueueMember = z.infer<typeof workQueueMemberSchema>;
export type WorkWaitingFor = z.infer<typeof workWaitingForSchema>;
