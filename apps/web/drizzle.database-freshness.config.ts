import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  driver: "durable-sqlite",
  schema: "./src/server/generic/problems/repo/database-freshness-sql-schema.ts",
  out: "./src/server/generic/problems/repo/database-freshness-migrations",
});
