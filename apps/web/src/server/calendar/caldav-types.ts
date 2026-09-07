import type {
  UserId,
  TaskShortcode,
  MealShortcode,
} from "@cubby/schemas/identifiers";
import {
  userId,
  taskShortcode,
  mealShortcode,
} from "@cubby/schemas/identifiers";
import type { MealType } from "@cubby/schemas/meal-classification";
import { mealTypeSchema } from "@cubby/schemas/meal-classification";
import type { TaskStatus } from "@cubby/schemas/project";
import { taskStatusSchema } from "@cubby/schemas/project";
import { z } from "zod";

export const CALDAV_COLLECTIONS = {
  tasks: "Cubby Tasks",
  "completed-tasks": "Cubby Completed Tasks",
  meals: "Cubby Meals",
} as const;
export type CalDavCollection = keyof typeof CALDAV_COLLECTIONS;
export type CalendarProjection =
  | {
      entity: "task";
      id: TaskShortcode;
      name: string;
      dueDate: string | null;
      dueEndDate: string | null;
      status: TaskStatus;
      updatedAt: string;
    }
  | {
      entity: "meal";
      id: MealShortcode;
      name: string | null;
      date: string;
      mealType: MealType | null;
      updatedAt: string;
    };
export interface CalendarIdentity {
  entity: "meal" | "task";
  shortcode: string;
  filename: string;
  uid: string;
}
export interface CalDavResource {
  collection: CalDavCollection;
  filename: string;
  uid: string;
  body: string;
  etag: string;
  start: string;
  end: string;
  projection: CalendarProjection;
}
export interface CalDavEventInput {
  uid: string;
  summary: string;
  startDate: string;
  endDateExclusive: string;
  mealType: MealType | null;
}
export interface CalDavWrite {
  operationId: string;
  actorId: UserId;
  collection: CalDavCollection;
  filename: string;
  expected: CalDavResource | null;
  event: CalDavEventInput | null;
}
export interface CalDavWriteResult {
  shortcode: string;
  deleted: boolean;
}
export class CalDavError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly condition?: string,
  ) {
    super(message);
  }
}
export interface CalDavBackend {
  authenticate(authorization: string | null): Promise<UserId | null>;
  ready(): boolean;
  list(
    collection: CalDavCollection,
    range?: { start?: string; end?: string },
  ): CalDavResource[];
  get(collection: CalDavCollection, filename: string): CalDavResource | null;
  write(request: {
    actorId: UserId;
    collection: CalDavCollection;
    filename: string;
    event: CalDavEventInput | null;
    ifMatch: string | null;
    ifNoneMatch: string | null;
    body: string | null;
  }): Promise<{ status: number; etag?: string }>;
}

export const calendarProjectionSchema = z.discriminatedUnion("entity", [
  z.object({
    entity: z.literal("task"),
    id: taskShortcode,
    name: z.string(),
    dueDate: z.string().nullable(),
    dueEndDate: z.string().nullable(),
    status: taskStatusSchema,
    updatedAt: z.string(),
  }),
  z.object({
    entity: z.literal("meal"),
    id: mealShortcode,
    name: z.string().nullable(),
    date: z.string(),
    mealType: mealTypeSchema.nullable(),
    updatedAt: z.string(),
  }),
]);
const collectionSchema = z.enum(["tasks", "completed-tasks", "meals"]);
const resourceSchema = z.object({
  collection: collectionSchema,
  filename: z.string(),
  uid: z.string(),
  body: z.string(),
  etag: z.string(),
  start: z.string(),
  end: z.string(),
  projection: calendarProjectionSchema,
});
export const calDavWriteSchema = z.object({
  operationId: z.string(),
  actorId: userId,
  collection: collectionSchema,
  filename: z.string(),
  expected: resourceSchema.nullable(),
  event: z
    .object({
      uid: z.string(),
      summary: z.string(),
      startDate: z.string(),
      endDateExclusive: z.string(),
      mealType: mealTypeSchema.nullable(),
    })
    .nullable(),
});
