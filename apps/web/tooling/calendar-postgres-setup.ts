import type { TestProject } from "vitest/node";
import { allocateCalendarTestDatabase } from "./test-setup";

declare module "vitest" {
  export interface ProvidedContext {
    calendarDatabaseUrl: string;
    calendarOwnerId: string;
  }
}

export default async function setup(project: TestProject) {
  const database = await allocateCalendarTestDatabase();
  project.provide("calendarDatabaseUrl", database.connectionString);
  project.provide("calendarOwnerId", database.ownerId);
  return database.close;
}
