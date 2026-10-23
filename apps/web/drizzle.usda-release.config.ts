import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  driver: "durable-sqlite",
  schema: "../../packages/usda/src/release/sql-schema.ts",
  out: "./src/server/domains/usda-release/repo/migrations",
});
