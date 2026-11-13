import { activityExecutor } from "@cubby/schemas/activity";
import { desc, eq, sql } from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";
import { z } from "zod";

import { imageProcessingEvent } from "~/server/db/generated/entity-table-definitions.gen";

export const receipt = z.object({
  id: z.uuid(),
  jobId: z.uuid(),
  number: z.number(),
  submissionId: z.uuid().nullable(),
  inputKey: z.string().nullable(),
  state: z.string(),
  executor: activityExecutor.nullable(),
  assignedUserId: z.string().nullable(),
  assignedConnectionId: z.string().nullable(),
  diagnostics: z.unknown(),
  result: z.unknown(),
  error: z.string().nullable(),
  startedAt: z.string(),
  completedAt: z.string().nullable(),
});
export type ImageExecutionReceipt = z.infer<typeof receipt>;
const data = imageProcessingEvent.details;
const text = (key: keyof ImageExecutionReceipt) =>
  sql<string>`${data}->>${sql.raw("'" + key + "'")}`;
const nullableText = (key: string) => sql<string | null>`${data}->>${key}`;
/** Member/device history projected from append-only execution receipts, not a work queue. */
export const imageExecutionReceipts = new QueryBuilder()
  .selectDistinctOn([text("id")], {
    id: sql<string>`(${text("id")})::uuid`.as("id"),
    jobId: imageProcessingEvent.jobId,
    number: sql<number>`(${text("number")})::integer`.as("number"),
    submissionId: nullableText("submissionId").as("submissionId"),
    inputKey: nullableText("inputKey").as("inputKey"),
    state: text("state").as("state"),
    executor: sql<z.infer<
      typeof activityExecutor
    > | null>`${data}->'executor'`.as("executor"),
    assignedUserId: nullableText("assignedUserId").as("assignedUserId"),
    assignedConnectionId: nullableText("assignedConnectionId").as(
      "assignedConnectionId",
    ),
    diagnostics: sql<unknown>`${data}->'diagnostics'`.as("diagnostics"),
    result: sql<unknown>`${data}->'result'`.as("result"),
    error: nullableText("error").as("error"),
    startedAt: sql`(${text("startedAt")})::timestamp`
      .mapWith((value: unknown) => z.coerce.date().parse(value))
      .as("startedAt"),
    completedAt: sql`(${text("completedAt")})::timestamp`
      .mapWith((value: unknown) =>
        value === null ? null : z.coerce.date().parse(value),
      )
      .as("completedAt"),
  })
  .from(imageProcessingEvent)
  .where(eq(imageProcessingEvent.event, "execution.receipt"))
  .orderBy(
    text("id"),
    desc(imageProcessingEvent.occurredAt),
    desc(imageProcessingEvent.id),
  )
  .as("imageExecutionReceipts");
