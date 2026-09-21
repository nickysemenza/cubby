import type {
  UserId,
  TaskShortcode,
  MealShortcode,
} from "@cubby/schemas/identifiers";
import { taskShortcode, mealShortcode } from "@cubby/schemas/identifiers";
import type { MealType } from "@cubby/schemas/meal-classification";
import { mealTypeSchema } from "@cubby/schemas/meal-classification";
import type { TaskStatus } from "@cubby/schemas/project";
import { taskStatusSchema } from "@cubby/schemas/project";
import type { Trade } from "@cubby/schemas/task-fields";
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
  trade?: Trade;
  uid: string;
  summary: string;
  startDate: string;
  endDateExclusive: string;
  mealType: MealType | null;
}
export interface CalDavWrite {
  actorId: UserId;
  collection: CalDavCollection;
  filename: string;
  expected: CalDavResource | null;
  event: CalDavEventInput;
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
    event: CalDavEventInput;
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
