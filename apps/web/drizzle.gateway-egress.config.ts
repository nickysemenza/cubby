import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  driver: "durable-sqlite",
  schema: "./src/server/ai/repo/gateway-egress-sql-schema.ts",
  out: "./src/server/ai/repo/gateway-egress-migrations",
});
