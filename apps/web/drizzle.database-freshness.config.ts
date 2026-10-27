import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  driver: "durable-sqlite",
  schema: "./src/server/db/freshness/database-freshness-sql-schema.ts",
  out: "./src/server/db/freshness/database-freshness-migrations",
});
