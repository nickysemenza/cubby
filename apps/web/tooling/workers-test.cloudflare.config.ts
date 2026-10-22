import { bindings, defineConfig, defineWorker } from "cf/config";

export const testWorker = defineWorker({
  name: "cubby-calendar-test",
  entrypoint: "./calendar-test-worker.ts",
  compatibilityDate: "2026-09-19",
  compatibilityFlags: ["nodejs_compat"],
  env: {
    AI_GATEWAY_EGRESS: bindings.durableObject({
      worker: "cubby-calendar-test",
      exportName: "AiGatewayEgressDurableObject",
    }),
    DB_FRESHNESS: bindings.durableObject({
      worker: "cubby-calendar-test",
      exportName: "DatabaseFreshnessDurableObject",
    }),
    CALENDAR_FEED: bindings.durableObject({
      worker: "cubby-calendar-test",
      exportName: "CalendarFeedDurableObject",
    }),
    AI_RESPONSE_CACHE: bindings.durableObject({
      worker: "cubby-calendar-test",
      exportName: "AiResponseCacheDurableObject",
    }),
    CHATGPT_PLAN: bindings.durableObject({
      worker: "cubby-calendar-test",
      exportName: "ChatGptPlanDurableObject",
    }),
    USDA_RELEASE: bindings.durableObject({
      worker: "cubby-calendar-test",
      exportName: "UsdaReleaseDurableObject",
    }),
    USDA_RELEASES: bindings.r2({ name: "cubby-usda-releases-test" }),
    // The agent host's import graph reaches the app's process-env schema,
    // whose R2 and auth secrets this hermetic worker never uses.
    SKIP_ENV_VALIDATION: bindings.text("1"),
    PURCHASE_IMPORT_RUN: bindings.durableObject({
      worker: "cubby-calendar-test",
      exportName: "PurchaseImportRunAgent",
    }),
  },
  exports: {
    AiGatewayEgressDurableObject: { type: "durable-object", storage: "sqlite" },
    DatabaseFreshnessDurableObject: {
      type: "durable-object",
      storage: "sqlite",
    },
    CalendarFeedDurableObject: { type: "durable-object", storage: "sqlite" },
    AiResponseCacheDurableObject: { type: "durable-object", storage: "sqlite" },
    ChatGptPlanDurableObject: { type: "durable-object", storage: "sqlite" },
    UsdaReleaseDurableObject: { type: "durable-object", storage: "sqlite" },
    PurchaseImportRunAgent: { type: "durable-object", storage: "sqlite" },
  },
});

export default defineConfig({ worker: testWorker });
