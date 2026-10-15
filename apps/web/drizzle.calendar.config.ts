import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  driver: "durable-sqlite",
  schema: "./src/server/domains/calendar/sql-schema.ts",
  out: "./src/server/domains/calendar/migrations",
});
